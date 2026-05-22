package e2e

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"connectrpc.com/connect"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	v1 "github.com/garethgeorge/backrest/gen/go/v1"
	"github.com/garethgeorge/backrest/gen/go/v1/v1connect"
	"github.com/garethgeorge/backrest/internal/testutil"
	"google.golang.org/protobuf/types/known/emptypb"
)

func TestDockerE2E(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Docker E2E tests are not supported on Windows in this environment")
	}

	// 1. Check for Docker daemon
	dockerCli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Skipf("Skipping Docker E2E test: failed to create docker client: %v", err)
	}
	_, err = dockerCli.Ping(context.Background())
	if err != nil {
		t.Skipf("Skipping Docker E2E test: docker daemon not reachable: %v", err)
	}

	// 2. Setup temp environment
	tmpDir, err := os.MkdirTemp("", "backrest-docker-e2e")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	binPath := filepath.Join(tmpDir, "backrest")
	buildCmd := exec.Command("go", "build", "-o", binPath, "../../cmd/backrest")
	if err := buildCmd.Run(); err != nil {
		t.Fatalf("failed to build backrest binary: %v", err)
	}

	addr := testutil.AllocOpenBindAddr(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cmd := exec.CommandContext(ctx, binPath,
		"-data-dir", tmpDir,
		"-config-file", filepath.Join(tmpDir, "config.json"),
		"-bind-address", addr)
	cmd.Stderr = os.Stderr
	cmd.Stdout = os.Stdout
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start backrest: %v", err)
	}

	// Wait for backrest to be ready
	testutil.TryNonfatal(t, ctx, func() error {
		resp, err := http.Get(fmt.Sprintf("http://%s", addr))
		if err != nil {
			return err
		}
		resp.Body.Close()
		return nil
	})

	apiClient := v1connect.NewBackrestClient(http.DefaultClient, fmt.Sprintf("http://%s", addr))

	// 3. Setup Docker resources
	volName := "backrest-test-vol"
	_, err = dockerCli.VolumeCreate(ctx, volume.CreateOptions{Name: volName})
	if err != nil {
		t.Fatalf("failed to create docker volume: %v", err)
	}
	defer dockerCli.VolumeRemove(ctx, volName, true)

	// Pull alpine image
	out, err := dockerCli.ImagePull(ctx, "docker.io/library/alpine:latest", image.PullOptions{})
	if err != nil {
		t.Fatalf("failed to pull alpine image: %v", err)
	}
	out.Close()

	// Start container
	containerName := "backrest-test-container"
	resp, err := dockerCli.ContainerCreate(ctx, &container.Config{
		Image: "alpine",
		Cmd:   []string{"sleep", "infinity"},
	}, &container.HostConfig{
		Mounts: []mount.Mount{
			{
				Type:   mount.TypeVolume,
				Source: volName,
				Target: "/data",
			},
		},
	}, nil, nil, containerName)
	if err != nil {
		t.Fatalf("failed to create container: %v", err)
	}
	containerID := resp.ID
	defer dockerCli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true})

	if err := dockerCli.ContainerStart(ctx, containerID, container.StartOptions{}); err != nil {
		t.Fatalf("failed to start container: %v", err)
	}

	// Inspect volume to get host path
	volInspect, err := dockerCli.VolumeInspect(ctx, volName)
	if err != nil {
		t.Fatalf("failed to inspect volume: %v", err)
	}
	hostPath := volInspect.Mountpoint

	t.Run("discovery", func(t *testing.T) {
		resp, err := apiClient.DiscoverDocker(ctx, connect.NewRequest(&emptypb.Empty{}))
		if err != nil {
			t.Fatalf("DiscoverDocker failed: %v", err)
		}

		found := false
		for _, c := range resp.Msg.Containers {
			if c.Name == containerName {
				for _, v := range c.Volumes {
					if v.Source == hostPath {
						found = true
						break
					}
				}
			}
		}
		if !found {
			t.Errorf("expected to find container %q with volume at %q", containerName, hostPath)
		}
	})

	t.Run("create plan and backup", func(t *testing.T) {
		// Ensure config has an Instance name so AddRepo doesn't fail
		respConfig, err := apiClient.GetConfig(ctx, connect.NewRequest(&emptypb.Empty{}))
		if err != nil {
			t.Fatalf("GetConfig failed: %v", err)
		}
		cfg := respConfig.Msg
		cfg.Instance = "test-instance"
		if _, err := apiClient.SetConfig(ctx, connect.NewRequest(cfg)); err != nil {
			t.Fatalf("SetConfig failed: %v", err)
		}

		// Add repo first
		_, err = apiClient.AddRepo(ctx, connect.NewRequest(&v1.AddRepoRequest{
			Repo: &v1.Repo{
				Id:       "test-repo",
				Uri:      filepath.Join(tmpDir, "test-repo"),
				Password: "1234",
			},
		}))
		if err != nil {
			t.Fatalf("AddRepo failed: %v", err)
		}

		// Create docker plan
		_, err = apiClient.CreateDockerPlans(ctx, connect.NewRequest(&v1.CreateDockerPlansRequest{
			RepoId: "test-repo",
			Plans: []*v1.DockerPlanDefinition{
				{
					ContainerName: containerName,
					VolumeName:    volName,
					Path:          hostPath,
				},
			},
		}))
		if err != nil {
			t.Fatalf("CreateDockerPlans failed: %v", err)
		}

		// Run backup
		_, err = apiClient.Backup(ctx, connect.NewRequest(&v1.BackupRequest{
			Value: fmt.Sprintf("docker-%s-%s", containerName, volName),
		}))
		if err != nil {
			t.Fatalf("Backup failed: %v", err)
		}

		// Wait for backup to finish (check operations)
		var lastOp *v1.Operation
		testutil.TryNonfatal(t, ctx, func() error {
			resp, err := apiClient.GetOperations(ctx, connect.NewRequest(&v1.GetOperationsRequest{
				LastN: 1,
			}))
			if err != nil {
				return err
			}
			if len(resp.Msg.Operations) == 0 {
				return fmt.Errorf("no operations found")
			}
			op := resp.Msg.Operations[0]
			if op.Status != v1.OperationStatus_STATUS_SUCCESS {
				return fmt.Errorf("backup operation not successful yet: %v", op.Status)
			}
			lastOp = op
			return nil
		})

		if lastOp == nil || lastOp.SnapshotId == "" {
			t.Fatalf("backup failed to produce a snapshot")
		}
	})

	t.Run("restore with container stop", func(t *testing.T) {
		// Get the plan ID created in previous step
		resp, err := apiClient.GetConfig(ctx, connect.NewRequest(&emptypb.Empty{}))
		if err != nil {
			t.Fatalf("GetConfig failed: %v", err)
		}
		if len(resp.Msg.Plans) == 0 {
			t.Fatalf("no plans found in config")
		}
		planId := resp.Msg.Plans[0].Id

		// Get last snapshot
		snaps, err := apiClient.ListSnapshots(ctx, connect.NewRequest(&v1.ListSnapshotsRequest{
			RepoId: "test-repo",
			PlanId: planId,
		}))
		if err != nil || len(snaps.Msg.Snapshots) == 0 {
			t.Fatalf("failed to list snapshots: %v", err)
		}
		snapId := snaps.Msg.Snapshots[0].Id

		// Trigger restore with stop_container: true
		_, err = apiClient.Restore(ctx, connect.NewRequest(&v1.RestoreSnapshotRequest{
			RepoId:        "test-repo",
			PlanId:        planId,
			SnapshotId:    snapId,
			Path:          "/", // Restore everything from snapshot
			Target:        hostPath,
			Overwrite:     true,
			StopContainer: true,
		}))
		if err != nil {
			t.Fatalf("Restore failed: %v", err)
		}

		// Wait for restore to finish
		testutil.TryNonfatal(t, ctx, func() error {
			resp, err := apiClient.GetOperations(ctx, connect.NewRequest(&v1.GetOperationsRequest{
				LastN: 1,
			}))
			if err != nil {
				return err
			}
			op := resp.Msg.Operations[0]
			if op.Status != v1.OperationStatus_STATUS_SUCCESS {
				return fmt.Errorf("restore operation not successful yet: %v", op.Status)
			}
			return nil
		})

		// Verify container is running again
		inspect, err := dockerCli.ContainerInspect(ctx, containerID)
		if err != nil {
			t.Fatalf("failed to inspect container: %v", err)
		}
		if inspect.State.Status != "running" {
			t.Errorf("expected container to be running, got %q", inspect.State.Status)
		}
	})
}
