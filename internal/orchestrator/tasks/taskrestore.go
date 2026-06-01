package tasks

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	v1 "github.com/garethgeorge/backrest/gen/go/v1"
	"github.com/garethgeorge/backrest/internal/docker"
	"github.com/garethgeorge/backrest/internal/platformutil"
	"go.uber.org/zap"
)

func NewOneoffRestoreTask(repo *v1.Repo, planID string, flowID int64, at time.Time, snapshotID, path, target string, overwrite, stopContainer bool, dockerContainer, databaseType string) Task {
	return &GenericOneoffTask{
		OneoffTask: OneoffTask{
			BaseTask: BaseTask{
				TaskType:   "restore",
				TaskName:   fmt.Sprintf("restore snapshot %q in repo %q", snapshotID, repo.Id),
				TaskRepo:   repo,
				TaskPlanID: planID,
			},
			FlowID: flowID,
			RunAt:  at,
			ProtoOp: &v1.Operation{
				SnapshotId: snapshotID,
				Op: &v1.Operation_OperationRestore{
					OperationRestore: &v1.OperationRestore{
						Path:   path,
						Target: target,
					},
				},
			},
		},
		Do: func(ctx context.Context, st ScheduledTask, taskRunner TaskRunner) error {
			return NotifyError(ctx, taskRunner, st.Task.Name(), restoreHelper(ctx, st, taskRunner, snapshotID, path, target, overwrite, stopContainer, dockerContainer, databaseType))
		},
	}
}

func restoreHelper(ctx context.Context, st ScheduledTask, taskRunner TaskRunner, snapshotID, path, target string, overwrite, stopContainer bool, dockerContainer, databaseType string) error {
	t := st.Task
	op := st.Op

	if snapshotID == "" || path == "" || target == "" {
		return errors.New("snapshotID, path, and target are required")
	}

	restoreOp := st.Op.GetOperationRestore()
	if restoreOp == nil {
		return errors.New("operation is not a restore operation")
	}

	if !overwrite {
		if _, err := os.Stat(target); err == nil {
			return fmt.Errorf("target directory %q already exists", target)
		}
	}

	if stopContainer {
		d, err := docker.NewDiscoverer()
		if err == nil {
			searchPath := target
			if path != "" && path != "/" {
				searchPath = filepath.Join(target, path)
			}
			containerIds, _ := d.FindContainersByHostPath(ctx, searchPath)
			if len(containerIds) > 0 {
				zap.L().Info("stopping containers for restore", zap.Strings("containerIds", containerIds))
				var stoppedIds []string
				for _, id := range containerIds {
					if err := d.StopContainer(ctx, id); err != nil {
						zap.L().Warn("failed to stop container for restore", zap.Error(err), zap.String("containerId", id))
					} else {
						stoppedIds = append(stoppedIds, id)
					}
				}

				defer func() {
					for _, id := range stoppedIds {
						zap.L().Info("restarting container after restore", zap.String("containerId", id))
						if err := d.StartContainer(context.Background(), id); err != nil {
							zap.L().Error("failed to restart container after restore", zap.Error(err), zap.String("containerId", id))
						}
					}
				}()
			}
		}
	}

	repo, err := taskRunner.GetRepoOrchestrator(t.RepoID())
	if err != nil {
		return fmt.Errorf("couldn't get repo %q: %w", t.RepoID(), err)
	}

	var sendWg sync.WaitGroup
	lastSent := time.Now() // debounce progress updates, these can endup being very frequent.
	summary, err := repo.Restore(ctx, snapshotID, path, target, func(entry *v1.RestoreProgressEntry) {
		sendWg.Wait()
		if time.Since(lastSent) < 1*time.Second {
			return
		}
		lastSent = time.Now()

		restoreOp.LastStatus = entry

		sendWg.Add(1)
		go func() {
			if err := taskRunner.UpdateOperation(op); err != nil {
				zap.S().Errorf("failed to update oplog with progress for restore: %v", err)
			}
			sendWg.Done()
		}()
	})

	if err != nil {
		return err
	}
	restoreOp.LastStatus = summary

	if dockerContainer != "" && databaseType != "" {
		l := taskRunner.Logger(ctx)
		l.Info("running automated database injection after restore", zap.String("container", dockerContainer), zap.String("database", databaseType))

		var dumpFile string
		plan, err := taskRunner.GetPlan(t.PlanID())
		if err == nil && plan != nil {
			for _, p := range plan.Paths {
				if strings.Contains(p, "backrest-") && strings.HasSuffix(p, "-dump.sql") {
					dumpFile = resolveRestoredPath(target, p)
					break
				}
			}
		}

		if dumpFile != "" {
			if _, err := os.Stat(dumpFile); err == nil {
				// Start the container first if it was stopped.
				if stopContainer {
					d, err := docker.NewDiscoverer()
					if err == nil {
						l.Info("starting container for database injection", zap.String("container", dockerContainer))
						if err := d.StartContainer(ctx, dockerContainer); err != nil {
							l.Warn("failed to start container for database injection", zap.Error(err), zap.String("container", dockerContainer))
						}
					}
				}

				if err := injectDatabaseDump(ctx, dockerContainer, databaseType, dumpFile, taskRunner); err != nil {
					return fmt.Errorf("failed to inject database dump: %w", err)
				}
			} else {
				l.Warn("database dump file not found for injection", zap.String("path", dumpFile))
			}
		} else {
			l.Warn("could not determine database dump path from plan paths")
		}
	}

	return nil
}

func resolveRestoredPath(target, p string) string {
	if target == "/" || target == "" {
		return p
	}
	cleanP := p
	if len(cleanP) > 1 && cleanP[1] == ':' {
		cleanP = cleanP[2:] // strip C:
	}
	cleanP = strings.TrimPrefix(cleanP, "/")
	cleanP = strings.TrimPrefix(cleanP, "\\")
	return filepath.Join(target, cleanP)
}

func injectDatabaseDump(ctx context.Context, containerName, databaseType, dumpFile string, runner TaskRunner) error {
	logger := runner.Logger(ctx)
	logger.Info(fmt.Sprintf("Injecting database dump from %s into container %s (%s)", dumpFile, containerName, databaseType))

	file, err := os.Open(dumpFile)
	if err != nil {
		return fmt.Errorf("failed to open dump file: %w", err)
	}
	defer file.Close()

	var args []string
	switch databaseType {
	case "postgres":
		args = []string{"exec", "-i", containerName, "sh", "-c", `export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -U postgres`}
	case "mysql", "mariadb":
		args = []string{"exec", "-i", containerName, "sh", "-c", `export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot`}
		if databaseType == "mariadb" {
			args = []string{"exec", "-i", containerName, "sh", "-c", `export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"; exec mysql -uroot`}
		}
	default:
		return fmt.Errorf("unsupported database type: %s", databaseType)
	}

	var lastErr error
	maxRetries := 10
	for attempt := 1; attempt <= maxRetries; attempt++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		logger.Info(fmt.Sprintf("Running database injection attempt %d/%d...", attempt, maxRetries))
		
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return fmt.Errorf("failed to seek dump file: %w", err)
		}
		
		execCmd := exec.Command("docker", args...)
		platformutil.SetPlatformOptions(execCmd)
		execCmd.Stdin = file

		var stdoutBuf, stderrBuf bytes.Buffer
		execCmd.Stdout = &stdoutBuf
		execCmd.Stderr = &stderrBuf

		err = execCmd.Run()
		if err == nil {
			logger.Info("Database injection completed successfully")
			return nil
		}

		lastErr = fmt.Errorf("attempt %d failed: %w (stderr: %s)", attempt, err, stderrBuf.String())
		logger.Warn(fmt.Sprintf("Database injection attempt %d failed, retrying in 2 seconds...", attempt), zap.Error(err))
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("database injection failed after %d attempts: %w", maxRetries, lastErr)
}
