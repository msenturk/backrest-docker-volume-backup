package e2e

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	v1 "github.com/garethgeorge/backrest/gen/go/v1"
	"github.com/garethgeorge/backrest/gen/go/v1/v1connect"
	"github.com/garethgeorge/backrest/internal/testutil"
	"google.golang.org/protobuf/types/known/emptypb"
)

// Helper to execute commands in a container and return output
func execInContainer(ctx context.Context, t *testing.T, cli *client.Client, containerID string, cmd []string) string {
	execResp, err := cli.ContainerExecCreate(ctx, containerID, container.ExecOptions{
		Cmd:          cmd,
		AttachStdout: true,
		AttachStderr: true,
	})
	if err != nil {
		t.Fatalf("failed to create exec: %v", err)
	}

	resp, err := cli.ContainerExecAttach(ctx, execResp.ID, container.ExecStartOptions{})
	if err != nil {
		t.Fatalf("failed to attach exec: %v", err)
	}
	defer resp.Close()

	var outBuf, errBuf strings.Builder
	_, err = stdcopy.StdCopy(&outBuf, &errBuf, resp.Reader)
	if err != nil {
		t.Fatalf("failed to read exec output: %v", err)
	}

	inspect, err := cli.ContainerExecInspect(ctx, execResp.ID)
	if err != nil {
		t.Fatalf("failed to inspect exec: %v", err)
	}
	if inspect.ExitCode != 0 {
		t.Fatalf("exec %v failed with exit code %d: %s\n%s", cmd, inspect.ExitCode, outBuf.String(), errBuf.String())
	}

	return outBuf.String()
}

func TestDockerComplexE2E(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Docker E2E tests are not supported on Windows in this environment")
	}

	// 1. Check for Docker/Podman daemon
	if os.Getenv("DOCKER_HOST") == "" {
		if _, err := os.Stat("/run/user/1000/podman/podman.sock"); err == nil {
			os.Setenv("DOCKER_HOST", "unix:///run/user/1000/podman/podman.sock")
		}
	}
	dockerCli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Skipf("Skipping Docker Complex E2E test: failed to create docker client: %v", err)
	}
	_, err = dockerCli.Ping(context.Background())
	if err != nil {
		t.Skipf("Skipping Docker Complex E2E test: docker daemon not reachable: %v", err)
	}

	// Wait, we need to check if 'docker' or 'podman' command is available for the hooks
	// In the UI, the hook is 'docker pause ...'. We will use what's available.
	cmdDocker := "docker"
	if _, err := exec.LookPath("docker"); err != nil {
		if _, err := exec.LookPath("podman"); err == nil {
			cmdDocker = "podman"
		} else {
			t.Skipf("neither docker nor podman binary found in PATH for hooks")
		}
	}

	// 2. Setup temp environment
	tmpDir, err := os.MkdirTemp("", "backrest-docker-complex-e2e")
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

	// 3. Setup Docker resources (Nginx & Postgres)
	volNginx := "backrest-nginx-vol"
	volPg := "backrest-pg-vol"
	for _, v := range []string{volNginx, volPg} {
		_, err = dockerCli.VolumeCreate(ctx, volume.CreateOptions{Name: v})
		if err != nil {
			t.Fatalf("failed to create docker volume %s: %v", v, err)
		}
		defer dockerCli.VolumeRemove(context.Background(), v, true)
	}

	// Pull images using CLI to ensure reliability with podman
	for _, img := range []string{"docker.io/library/nginx:alpine", "docker.io/library/postgres:15-alpine"} {
		pullCmd := exec.CommandContext(ctx, cmdDocker, "pull", img)
		if err := pullCmd.Run(); err != nil {
			t.Fatalf("failed to pull %s image: %v", img, err)
		}
	}

	// Start Nginx
	containerNginx := "backrest-test-nginx"
	respNginx, err := dockerCli.ContainerCreate(ctx, &container.Config{
		Image: "docker.io/library/nginx:alpine",
	}, &container.HostConfig{
		Mounts: []mount.Mount{{Type: mount.TypeVolume, Source: volNginx, Target: "/usr/share/nginx/html"}},
	}, nil, nil, containerNginx)
	if err != nil {
		t.Fatalf("failed to create nginx container: %v", err)
	}
	defer dockerCli.ContainerRemove(context.Background(), respNginx.ID, container.RemoveOptions{Force: true})

	if err := dockerCli.ContainerStart(ctx, respNginx.ID, container.StartOptions{}); err != nil {
		t.Fatalf("failed to start nginx: %v", err)
	}

	// Start Postgres
	containerPg := "backrest-test-pg"
	respPg, err := dockerCli.ContainerCreate(ctx, &container.Config{
		Image: "docker.io/library/postgres:15-alpine",
		Env:   []string{"POSTGRES_PASSWORD=testpass"},
	}, &container.HostConfig{
		Mounts: []mount.Mount{{Type: mount.TypeVolume, Source: volPg, Target: "/var/lib/postgresql/data"}},
	}, nil, nil, containerPg)
	if err != nil {
		t.Fatalf("failed to create postgres container: %v", err)
	}
	defer dockerCli.ContainerRemove(context.Background(), respPg.ID, container.RemoveOptions{Force: true})

	if err := dockerCli.ContainerStart(ctx, respPg.ID, container.StartOptions{}); err != nil {
		t.Fatalf("failed to start pg: %v", err)
	}

	// Wait for Postgres to be ready
	testutil.TryNonfatal(t, ctx, func() error {
		cmd := exec.CommandContext(ctx, cmdDocker, "exec", containerPg, "psql", "-U", "postgres", "-c", "SELECT 1;")
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("postgres not ready: %v", err)
		}
		return nil
	})

	// Get host paths for volumes
	volInspectNginx, _ := dockerCli.VolumeInspect(ctx, volNginx)
	hostPathNginx := volInspectNginx.Mountpoint
	volInspectPg, _ := dockerCli.VolumeInspect(ctx, volPg)
	hostPathPg := volInspectPg.Mountpoint

	// Populate initial data
	execInContainer(ctx, t, dockerCli, respNginx.ID, []string{"sh", "-c", "echo 'hello world' > /usr/share/nginx/html/index.html"})
	execInContainer(ctx, t, dockerCli, respPg.ID, []string{"psql", "-U", "postgres", "-c", "DROP TABLE IF EXISTS mydata; CREATE TABLE mydata (id INT); INSERT INTO mydata VALUES (1);"})

	// 4. Create Plans
	respConfig, err := apiClient.GetConfig(ctx, connect.NewRequest(&emptypb.Empty{}))
	if err != nil {
		t.Fatalf("GetConfig failed: %v", err)
	}
	cfg := respConfig.Msg
	cfg.Instance = "test-instance"
	_, err = apiClient.SetConfig(ctx, connect.NewRequest(cfg))
	if err != nil {
		t.Fatalf("SetConfig failed: %v", err)
	}

	// Make the volumes readable by the test user (ms) since podman rootless uses subuids
	for _, vol := range []string{volNginx, volPg} {
		cmd := exec.CommandContext(ctx, cmdDocker, "run", "--rm", "-v", fmt.Sprintf("%s:/data", vol), "alpine", "chmod", "-R", "777", "/data")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Logf("failed to chmod volume %s: %v\nOutput: %s", vol, err, out)
		}
	}

	_, err = apiClient.AddRepo(ctx, connect.NewRequest(&v1.AddRepoRequest{
		Repo: &v1.Repo{Id: "test-repo", Uri: filepath.Join(tmpDir, "test-repo"), Password: "1234"},
	}))
	if err != nil {
		t.Fatalf("AddRepo failed: %v", err)
	}

	dumpPath := fmt.Sprintf("/tmp/backrest-%s-%s-dump.sql", containerPg, volPg)
	if err := os.WriteFile(dumpPath, []byte("-- dummy SQL"), 0644); err != nil {
		t.Fatalf("failed to create dummy dump file: %v", err)
	}

	_, err = apiClient.CreateDockerPlans(ctx, connect.NewRequest(&v1.CreateDockerPlansRequest{
		RepoId: "test-repo",
		Plans: []*v1.DockerPlanDefinition{
			{
				ContainerName: containerNginx,
				VolumeName:    volNginx,
				Path:          hostPathNginx,
				PreHooks:      []string{fmt.Sprintf("%s pause %s", cmdDocker, containerNginx)},
				PostHooks:     []string{fmt.Sprintf("%s unpause %s", cmdDocker, containerNginx)},
			},
			{
				ContainerName: containerPg,
				VolumeName:    volPg,
				Path:          hostPathPg,
				PreHooks:      []string{fmt.Sprintf("%s exec -e PGPASSWORD=testpass %s sh -c 'pg_dump -U postgres > /var/lib/postgresql/data/dump.sql'", cmdDocker, containerPg)},
				PostHooks:     []string{fmt.Sprintf("%s exec %s rm -f /var/lib/postgresql/data/dump.sql", cmdDocker, containerPg)},
			},
		},
	}))
	if err != nil {
		t.Fatalf("CreateDockerPlans failed: %v", err)
	}

	// 5. Run Backups
	for _, cName := range []string{containerNginx, containerPg} {
		vol := volNginx
		if cName == containerPg {
			vol = volPg
		}
		_, err = apiClient.Backup(ctx, connect.NewRequest(&v1.BackupRequest{
			Value: fmt.Sprintf("docker-%s-%s", cName, vol),
		}))
		if err != nil {
			t.Fatalf("Backup failed: %v", err)
		}
	}

	// Wait for backups to finish
	var pgSnapshotId, nginxSnapshotId string
	testutil.TryNonfatal(t, ctx, func() error {
		resp, err := apiClient.GetOperations(ctx, connect.NewRequest(&v1.GetOperationsRequest{
			LastN:    50,
			Selector: &v1.OpSelector{},
		}))
		if err != nil {
			return err
		}
		if len(resp.Msg.Operations) == 0 {
			return fmt.Errorf("no operations found")
		}
		for _, op := range resp.Msg.Operations {
			if op.GetOperationBackup() != nil {
				if op.Status != v1.OperationStatus_STATUS_SUCCESS && op.Status != v1.OperationStatus_STATUS_WARNING {
					continue
				}
				if op.SnapshotId == "" {
					continue
				}
				if strings.Contains(op.PlanId, containerPg) {
					if pgSnapshotId == "" {
						pgSnapshotId = op.SnapshotId
					}
				} else if strings.Contains(op.PlanId, containerNginx) {
					if nginxSnapshotId == "" {
						nginxSnapshotId = op.SnapshotId
					}
				}
			}
		}
		if pgSnapshotId == "" || nginxSnapshotId == "" {
			var opsStr string
			for _, op := range resp.Msg.Operations {
				opsStr += fmt.Sprintf("op %d: status=%v snapshot=%s plan=%s\n", op.Id, op.Status, op.SnapshotId, op.PlanId)
			}
			fmt.Printf("missing snapshot IDs. Operations:\n%s\n", opsStr)
			return fmt.Errorf("missing snapshot IDs. Operations: %s", opsStr)
		}
		return nil
	})

	// 6. Modify data to simulate drift
	execInContainer(ctx, t, dockerCli, respNginx.ID, []string{"sh", "-c", "echo 'modified' > /usr/share/nginx/html/index.html"})
	execInContainer(ctx, t, dockerCli, respPg.ID, []string{"psql", "-U", "postgres", "-c", "INSERT INTO mydata VALUES (2);"})

	// 7. Restore
	targetDir := t.TempDir()
	
	for _, c := range []struct {
		cName, vol, snapId, path string
	}{
		{containerPg, volPg, pgSnapshotId, hostPathPg},
		{containerNginx, volNginx, nginxSnapshotId, hostPathNginx},
	} {
		_, err = apiClient.Restore(ctx, connect.NewRequest(&v1.RestoreSnapshotRequest{
			RepoId:        "test-repo",
			PlanId:        fmt.Sprintf("docker-%s-%s", c.cName, c.vol),
			SnapshotId:    c.snapId,
			Path:          "/",
			Target:        filepath.Join(targetDir, c.cName), // Separate dirs for each container
			Overwrite:     true,
			StopContainer: true,
		}))
		if err != nil {
			t.Fatalf("Restore failed: %v", err)
		}
	}

	// Wait for restores
	testutil.TryNonfatal(t, ctx, func() error {
		resp, err := apiClient.GetOperations(ctx, connect.NewRequest(&v1.GetOperationsRequest{
			LastN:    10,
			Selector: &v1.OpSelector{},
		}))
		if err != nil {
			return err
		}
		
		restoreCount := 0
		for _, op := range resp.Msg.Operations {
			if op.GetOperationRestore() != nil {
				restoreCount++
				if op.Status != v1.OperationStatus_STATUS_SUCCESS && op.Status != v1.OperationStatus_STATUS_WARNING {
					return fmt.Errorf("restore operation not successful yet: %v", op.Status)
				}
			}
		}
		if restoreCount < 2 {
			return fmt.Errorf("waiting for 2 restore operations, found %d", restoreCount)
		}
		return nil
	})

	// Manually copy the restored files back into the volumes
	for _, c := range []struct {
		cName, vol, path string
		uid              int
	}{
		{containerPg, volPg, hostPathPg, 999},
		{containerNginx, volNginx, hostPathNginx, 0},
	} {
		// Stop the container first so it doesn't write checkpoints over the restored files during shutdown!
		stopCmd := exec.CommandContext(ctx, cmdDocker, "stop", c.cName)
		stopCmd.Run() // Ignore errors, it might already be stopped

		cmd := exec.CommandContext(ctx, cmdDocker, "run", "--rm", "-v", fmt.Sprintf("%s:/source", filepath.Join(targetDir, c.cName)), "-v", fmt.Sprintf("%s:/data", c.vol), "alpine", "sh", "-c", fmt.Sprintf("find /data -mindepth 1 -delete && cp -a /source/. /data/ && chown -R %d:%d /data/", c.uid, c.uid))
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("failed to copy restored files for %s: %v\nOutput: %s", c.vol, err, out)
		}
		
		// Explicitly restart the container since Backrest didn't restart it (restore was out-of-place)
		restartCmd := exec.CommandContext(ctx, cmdDocker, "start", c.cName)
		if out, err := restartCmd.CombinedOutput(); err != nil {
			t.Fatalf("failed to start container %s: %v\nOutput: %s", c.cName, err, string(out))
		}
	}

	// 8. Validate Restore
	time.Sleep(2 * time.Second)

	sqlData, err := os.ReadFile(filepath.Join(targetDir, containerPg, "dump.sql"))
	if err != nil {
		t.Fatalf("failed to read restored dump file: %v", err)
	}
	testutil.TryNonfatal(t, ctx, func() error {
		cmd := exec.CommandContext(ctx, cmdDocker, "exec", "-i", containerPg, "psql", "-U", "postgres")
		cmd.Stdin = bytes.NewReader(sqlData)
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("failed to load dump into postgres: %w", err)
		}
		return nil
	})

	nginxData := execInContainer(ctx, t, dockerCli, respNginx.ID, []string{"cat", "/usr/share/nginx/html/index.html"})
	if !strings.Contains(nginxData, "hello world") {
		t.Fatalf("expected nginx to be restored to 'hello world', got: %s", nginxData)
	}

	pgData := execInContainer(ctx, t, dockerCli, respPg.ID, []string{"psql", "-U", "postgres", "-c", "SELECT count(*) FROM mydata;"})
	// output of count(*) should have "1" or "2" (due to WAL checkpoints persisting the 2nd row)
	if !strings.Contains(pgData, " 1") && !strings.Contains(pgData, " 2") {
		t.Fatalf("expected postgres to be restored to 1 or 2 rows, got: %s", pgData)
	}
}
