package tasks

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	v1 "github.com/garethgeorge/backrest/gen/go/v1"
	"github.com/garethgeorge/backrest/internal/docker"
	"go.uber.org/zap"
)

func NewOneoffRestoreTask(repo *v1.Repo, planID string, flowID int64, at time.Time, snapshotID, path, target string, overwrite, stopContainer bool) Task {
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
			return NotifyError(ctx, taskRunner, st.Task.Name(), restoreHelper(ctx, st, taskRunner, snapshotID, path, target, overwrite, stopContainer))
		},
	}
}

func restoreHelper(ctx context.Context, st ScheduledTask, taskRunner TaskRunner, snapshotID, path, target string, overwrite, stopContainer bool) error {
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
			containerIds, _ := d.FindContainersByHostPath(ctx, target)
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

	return nil
}
