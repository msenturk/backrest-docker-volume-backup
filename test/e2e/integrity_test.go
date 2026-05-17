package e2e

import (
	"context"
	"fmt"
	"io"
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
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	v1 "github.com/garethgeorge/backrest/gen/go/v1"
	"github.com/garethgeorge/backrest/gen/go/v1/v1connect"
	"github.com/garethgeorge/backrest/internal/testutil"
)

// runExec executes a command inside a running Docker container and parses the output,
// stripping out Docker's stdout/stderr multiplex headers (8 bytes).
func runExec(ctx context.Context, cli *client.Client, containerID string, cmd []string) (string, error) {
	execConfig := container.ExecOptions{
		Cmd:          cmd,
		AttachStdout: true,
		AttachStderr: true,
	}
	execCreate, err := cli.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		return "", err
	}
	resp, err := cli.ContainerExecAttach(ctx, execCreate.ID, container.ExecStartOptions{})
	if err != nil {
		return "", err
	}
	defer resp.Close()

	data, err := io.ReadAll(resp.Reader)
	if err != nil {
		return "", err
	}

	var result []byte
	for i := 0; i < len(data); {
		if i+8 > len(data) {
			break
		}
		size := int(data[i+4])<<24 | int(data[i+5])<<16 | int(data[i+6])<<8 | int(data[i+7])
		if i+8+size > len(data) {
			result = append(result, data[i+8:]...)
			break
		}
		result = append(result, data[i+8:i+8+size]...)
		i += 8 + size
	}
	return string(result), nil
}

func TestIntegrityE2E(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Docker E2E integrity tests are not supported on Windows host in this environment")
	}

	// 1. Establish Docker client connection
	dockerCli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Skipf("Skipping Integrity E2E: Docker client connection failed: %v", err)
	}
	_, err = dockerCli.Ping(context.Background())
	if err != nil {
		t.Skipf("Skipping Integrity E2E: Docker daemon is unreachable: %v", err)
	}

	// 2. Setup temporary Backrest directory structure
	tmpDir, err := os.MkdirTemp("", "backrest-integrity-e2e")
	if err != nil {
		t.Fatalf("failed to create temporary directory: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	binPath := filepath.Join(tmpDir, "backrest")
	buildCmd := exec.Command("go", "build", "-o", binPath, "../../cmd/backrest")
	buildCmd.Stderr = os.Stderr
	buildCmd.Stdout = os.Stdout
	if err := buildCmd.Run(); err != nil {
		t.Fatalf("failed to compile backrest binary: %v", err)
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
		t.Fatalf("failed to start Backrest background server: %v", err)
	}

	// Wait for Backrest API server to become ready
	testutil.TryNonfatal(t, ctx, func() error {
		resp, err := http.Get(fmt.Sprintf("http://%s", addr))
		if err != nil {
			return err
		}
		resp.Body.Close()
		return nil
	})

	apiClient := v1connect.NewBackrestClient(http.DefaultClient, fmt.Sprintf("http://%s", addr))

	// 3. Configure Database Volume and Container
	dbVolName := "backrest-integrity-db-vol"
	_, err = dockerCli.VolumeCreate(ctx, volume.CreateOptions{Name: dbVolName})
	if err != nil {
		t.Fatalf("failed to create database Docker volume: %v", err)
	}
	defer dockerCli.VolumeRemove(ctx, dbVolName, true)

	dbVolInspect, err := dockerCli.VolumeInspect(ctx, dbVolName)
	if err != nil {
		t.Fatalf("failed to inspect database volume: %v", err)
	}
	dbHostPath := dbVolInspect.Mountpoint

	// Pull PostgreSQL Image
	dbReader, err := dockerCli.ImagePull(ctx, "docker.io/library/postgres:15-alpine", image.PullOptions{})
	if err != nil {
		t.Fatalf("failed to pull postgres image: %v", err)
	}
	dbReader.Close()

	dbContainerName := "backrest-integrity-postgres"
	dbResp, err := dockerCli.ContainerCreate(ctx, &container.Config{
		Image: "postgres:15-alpine",
		Env:   []string{"POSTGRES_PASSWORD=integrity_secret"},
	}, &container.HostConfig{
		Mounts: []mount.Mount{
			{
				Type:   mount.TypeVolume,
				Source: dbVolName,
				Target: "/var/lib/postgresql/data",
			},
		},
	}, nil, nil, dbContainerName)
	if err != nil {
		t.Fatalf("failed to create postgres container: %v", err)
	}
	dbContainerID := dbResp.ID
	defer dockerCli.ContainerRemove(ctx, dbContainerID, container.RemoveOptions{Force: true})

	if err := dockerCli.ContainerStart(ctx, dbContainerID, container.StartOptions{}); err != nil {
		t.Fatalf("failed to start postgres container: %v", err)
	}

	// Wait for PostgreSQL database engine to start accepting connections
	var dbReady bool
	for i := 0; i < 30; i++ {
		out, _ := runExec(ctx, dockerCli, dbContainerID, []string{"pg_isready", "-U", "postgres"})
		if strings.Contains(out, "accepting connections") {
			dbReady = true
			break
		}
		time.Sleep(1 * time.Second)
	}
	if !dbReady {
		t.Fatalf("PostgreSQL container did not start accepting connections in time")
	}

	// 4. Configure Web Service Volume and Container
	webVolName := "backrest-integrity-web-vol"
	_, err = dockerCli.VolumeCreate(ctx, volume.CreateOptions{Name: webVolName})
	if err != nil {
		t.Fatalf("failed to create web service Docker volume: %v", err)
	}
	defer dockerCli.VolumeRemove(ctx, webVolName, true)

	webVolInspect, err := dockerCli.VolumeInspect(ctx, webVolName)
	if err != nil {
		t.Fatalf("failed to inspect web volume: %v", err)
	}
	webHostPath := webVolInspect.Mountpoint

	// Pull Alpine Image
	webReader, err := dockerCli.ImagePull(ctx, "docker.io/library/alpine:latest", image.PullOptions{})
	if err != nil {
		t.Fatalf("failed to pull alpine image: %v", err)
	}
	webReader.Close()

	webContainerName := "backrest-integrity-web"
	webResp, err := dockerCli.ContainerCreate(ctx, &container.Config{
		Image: "alpine",
		Cmd:   []string{"sleep", "infinity"},
	}, &container.HostConfig{
		Mounts: []mount.Mount{
			{
				Type:   mount.TypeVolume,
				Source: webVolName,
				Target: "/webdata",
			},
		},
	}, nil, nil, webContainerName)
	if err != nil {
		t.Fatalf("failed to create web container: %v", err)
	}
	webContainerID := webResp.ID
	defer dockerCli.ContainerRemove(ctx, webContainerID, container.RemoveOptions{Force: true})

	if err := dockerCli.ContainerStart(ctx, webContainerID, container.StartOptions{}); err != nil {
		t.Fatalf("failed to start web container: %v", err)
	}

	// 5. Generate Initial High-Integrity Test Data
	// A. Generate DB tables and records
	_, _ = runExec(ctx, dockerCli, dbContainerID, []string{"psql", "-U", "postgres", "-d", "postgres", "-c", "CREATE TABLE integrity_check (id SERIAL PRIMARY KEY, val TEXT);"})
	_, _ = runExec(ctx, dockerCli, dbContainerID, []string{"psql", "-U", "postgres", "-d", "postgres", "-c", "INSERT INTO integrity_check (val) VALUES ('database_data_integrity_token_1'), ('database_data_integrity_token_2');"})
	dbDataBefore, err := runExec(ctx, dockerCli, dbContainerID, []string{"psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", "SELECT * FROM integrity_check ORDER BY id;"})
	if err != nil || strings.TrimSpace(dbDataBefore) == "" {
		t.Fatalf("failed to seed database integrity test rows: %v", err)
	}

	// B. Generate Web static files
	_, _ = runExec(ctx, dockerCli, webContainerID, []string{"mkdir", "-p", "/webdata/public"})
	_, _ = runExec(ctx, dockerCli, webContainerID, []string{"sh", "-c", "echo 'web_backup_html_integrity_token_content' > /webdata/public/index.html"})
	_, _ = runExec(ctx, dockerCli, webContainerID, []string{"sh", "-c", "echo 'web_backup_css_integrity_token_content' > /webdata/public/style.css"})
	webHashBefore, err := runExec(ctx, dockerCli, webContainerID, []string{"sh", "-c", "sha256sum /webdata/public/* | sort"})
	if err != nil || strings.TrimSpace(webHashBefore) == "" {
		t.Fatalf("failed to seed web static files: %v", err)
	}

	// 6. Register Backrest Repository and Create Docker Plans
	_, err = apiClient.AddRepo(ctx, connect.NewRequest(&v1.AddRepoRequest{
		Repo: &v1.Repo{
			Id:       "integrity-repo",
			Uri:      filepath.Join(tmpDir, "integrity-repo"),
			Password: "secure_integrity_password",
		},
	}))
	if err != nil {
		t.Fatalf("AddRepo failed: %v", err)
	}

	// Register Docker Volume Backup Plans for both Database and Web service
	_, err = apiClient.CreateDockerPlans(ctx, connect.NewRequest(&v1.CreateDockerPlansRequest{
		RepoId: "integrity-repo",
		Plans: []*v1.DockerPlanDefinition{
			{
				ContainerName: dbContainerName,
				VolumeName:    dbVolName,
				Path:          dbHostPath,
			},
			{
				ContainerName: webContainerName,
				VolumeName:    webVolName,
				Path:          webHostPath,
			},
		},
	}))
	if err != nil {
		t.Fatalf("CreateDockerPlans failed: %v", err)
	}

	// 7. Perform Backups
	// A. Database backup
	dbPlanId := fmt.Sprintf("docker-%s-%s", dbContainerName, dbVolName)
	_, err = apiClient.Backup(ctx, connect.NewRequest(&v1.BackupRequest{Value: dbPlanId}))
	if err != nil {
		t.Fatalf("Database backup trigger failed: %v", err)
	}

	// Wait for database backup operation to succeed
	var dbSnapshotId string
	testutil.TryNonfatal(t, ctx, func() error {
		resp, err := apiClient.GetOperations(ctx, connect.NewRequest(&v1.GetOperationsRequest{LastN: 10}))
		if err != nil {
			return err
		}
		for _, op := range resp.Msg.Operations {
			if op.PlanId == dbPlanId && op.Status == v1.OperationStatus_STATUS_SUCCESS {
				dbSnapshotId = op.SnapshotId
				return nil
			}
		}
		return fmt.Errorf("database backup operation not finished successfully yet")
	})

	// B. Web service backup
	webPlanId := fmt.Sprintf("docker-%s-%s", webContainerName, webVolName)
	_, err = apiClient.Backup(ctx, connect.NewRequest(&v1.BackupRequest{Value: webPlanId}))
	if err != nil {
		t.Fatalf("Web backup trigger failed: %v", err)
	}

	// Wait for web backup operation to succeed
	var webSnapshotId string
	testutil.TryNonfatal(t, ctx, func() error {
		resp, err := apiClient.GetOperations(ctx, connect.NewRequest(&v1.GetOperationsRequest{LastN: 10}))
		if err != nil {
			return err
		}
		for _, op := range resp.Msg.Operations {
			if op.PlanId == webPlanId && op.Status == v1.OperationStatus_STATUS_SUCCESS {
				webSnapshotId = op.SnapshotId
				return nil
			}
		}
		return fmt.Errorf("web backup operation not finished successfully yet")
	})

	// 8. Simulate Catastrophic Disaster (Drop Database and Delete Web Files)
	// A. Delete DB data
	_, _ = runExec(ctx, dockerCli, dbContainerID, []string{"psql", "-U", "postgres", "-d", "postgres", "-c", "DROP TABLE integrity_check;"})
	dbDataCorrupted, _ := runExec(ctx, dockerCli, dbContainerID, []string{"psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", "SELECT * FROM integrity_check ORDER BY id;"})
	if strings.Contains(dbDataCorrupted, "database_data_integrity_token") {
		t.Fatalf("failed to simulate database disaster (data still exists)")
	}

	// B. Delete web files
	_, _ = runExec(ctx, dockerCli, webContainerID, []string{"sh", "-c", "rm -rf /webdata/public/*"})
	webFilesCorrupted, _ := runExec(ctx, dockerCli, webContainerID, []string{"ls", "-la", "/webdata/public"})
	if strings.Contains(webFilesCorrupted, "index.html") {
		t.Fatalf("failed to simulate web disaster (files still exist)")
	}

	// 9. Perform Restores with Container Stops to Guarantee Consistency
	// A. Restore Database
	_, err = apiClient.Restore(ctx, connect.NewRequest(&v1.RestoreSnapshotRequest{
		RepoId:        "integrity-repo",
		PlanId:        dbPlanId,
		SnapshotId:    dbSnapshotId,
		Path:          "/",
		Target:        dbHostPath,
		Overwrite:     true,
		StopContainer: true,
	}))
	if err != nil {
		t.Fatalf("Database restore failed: %v", err)
	}

	// Wait for database restore to finish
	testutil.TryNonfatal(t, ctx, func() error {
		resp, err := apiClient.GetOperations(ctx, connect.NewRequest(&v1.GetOperationsRequest{LastN: 1}))
		if err != nil {
			return err
		}
		if len(resp.Msg.Operations) > 0 && resp.Msg.Operations[0].Status == v1.OperationStatus_STATUS_SUCCESS {
			return nil
		}
		return fmt.Errorf("database restore operation not successful yet")
	})

	// B. Restore Web Files
	_, err = apiClient.Restore(ctx, connect.NewRequest(&v1.RestoreSnapshotRequest{
		RepoId:        "integrity-repo",
		PlanId:        webPlanId,
		SnapshotId:    webSnapshotId,
		Path:          "/",
		Target:        webHostPath,
		Overwrite:     true,
		StopContainer: true,
	}))
	if err != nil {
		t.Fatalf("Web restore failed: %v", err)
	}

	// Wait for web restore to finish
	testutil.TryNonfatal(t, ctx, func() error {
		resp, err := apiClient.GetOperations(ctx, connect.NewRequest(&v1.GetOperationsRequest{LastN: 1}))
		if err != nil {
			return err
		}
		if len(resp.Msg.Operations) > 0 && resp.Msg.Operations[0].Status == v1.OperationStatus_STATUS_SUCCESS {
			return nil
		}
		return fmt.Errorf("web restore operation not successful yet")
	})

	// 10. Wait for containers to boot up and verify absolute byte-perfect data integrity!
	// A. Verify Database integrity
	dbReadyAfter := false
	for i := 0; i < 30; i++ {
		out, _ := runExec(ctx, dockerCli, dbContainerID, []string{"pg_isready", "-U", "postgres"})
		if strings.Contains(out, "accepting connections") {
			dbReadyAfter = true
			break
		}
		time.Sleep(1 * time.Second)
	}
	if !dbReadyAfter {
		t.Fatalf("PostgreSQL container did not recover to ready state after restore")
	}

	dbDataAfter, err := runExec(ctx, dockerCli, dbContainerID, []string{"psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", "SELECT * FROM integrity_check ORDER BY id;"})
	if err != nil {
		t.Fatalf("failed to query database table after restore: %v", err)
	}

	if strings.TrimSpace(dbDataBefore) != strings.TrimSpace(dbDataAfter) {
		t.Errorf("DATABASE DATA INTEGRITY FAILURE!\nExpected:\n%s\nGot:\n%s", dbDataBefore, dbDataAfter)
	} else {
		t.Logf("DATABASE DATA INTEGRITY VERIFIED (100%% identical!)")
	}

	// B. Verify Web static files integrity
	webHashAfter, err := runExec(ctx, dockerCli, webContainerID, []string{"sh", "-c", "sha256sum /webdata/public/* | sort"})
	if err != nil {
		t.Fatalf("failed to compute web static files checksum after restore: %v", err)
	}

	if strings.TrimSpace(webHashBefore) != strings.TrimSpace(webHashAfter) {
		t.Errorf("WEB FILES DATA INTEGRITY FAILURE!\nExpected:\n%s\nGot:\n%s", webHashBefore, webHashAfter)
	} else {
		t.Logf("WEB FILES DATA INTEGRITY VERIFIED (100%% identical!)")
	}
}
