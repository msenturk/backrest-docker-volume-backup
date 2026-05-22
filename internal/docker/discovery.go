package docker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	v1 "github.com/garethgeorge/backrest/gen/go/v1"
)

type DiscoveryService struct {
	cli *client.Client
}

func NewDiscoverer() (*DiscoveryService, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("failed to create docker client: %w", err)
	}
	return &DiscoveryService{cli: cli}, nil
}

func pathIntersects(p1, p2 string) bool {
	ep1, err1 := filepath.EvalSymlinks(p1)
	if err1 != nil {
		ep1 = p1
	}
	ep2, err2 := filepath.EvalSymlinks(p2)
	if err2 != nil {
		ep2 = p2
	}

	rel1, err1 := filepath.Rel(ep1, ep2)
	if err1 == nil && !strings.HasPrefix(rel1, "..") {
		return true // p2 is inside p1 or equal
	}
	rel2, err2 := filepath.Rel(ep2, ep1)
	if err2 == nil && !strings.HasPrefix(rel2, "..") {
		return true // p1 is inside p2
	}
	return p1 == p2
}

func (d *DiscoveryService) StopContainer(ctx context.Context, id string) error {
	return d.cli.ContainerStop(ctx, id, container.StopOptions{})
}

func (d *DiscoveryService) StartContainer(ctx context.Context, id string) error {
	return d.cli.ContainerStart(ctx, id, container.StartOptions{})
}

func (d *DiscoveryService) FindContainersByHostPath(ctx context.Context, path string) ([]string, error) {
	containers, err := d.cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("failed to list containers: %w", err)
	}

	var results []string
	for _, c := range containers {
		info, err := d.cli.ContainerInspect(ctx, c.ID)
		if err != nil {
			continue
		}

		for _, m := range info.Mounts {
			if pathIntersects(m.Source, path) {
				results = append(results, c.ID)
				break
			}
		}
	}

	return results, nil
}

func (d *DiscoveryService) Discover(ctx context.Context, currentConfig *v1.Config) ([]*v1.DockerContainer, bool, error) {

	containers, err := d.cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, false, fmt.Errorf("failed to list containers: %w", err)
	}

	var result []*v1.DockerContainer
	isRemote := false
	if host := os.Getenv("DOCKER_HOST"); host != "" && !strings.HasPrefix(host, "unix://") && !strings.HasPrefix(host, "/") {
		isRemote = true
	}

	// Map to track already backed up paths for quick lookup
	backedUpPaths := make(map[string]string)
	for _, plan := range currentConfig.Plans {
		for _, p := range plan.Paths {
			backedUpPaths[p] = plan.Id
		}
	}

	for _, c := range containers {
		info, err := d.cli.ContainerInspect(ctx, c.ID)
		if err != nil {
			continue
		}

		containerName := strings.TrimPrefix(info.Name, "/")
		composeProject := info.Config.Labels["com.docker.compose.project"]

		dc := &v1.DockerContainer{
			Id:             c.ID,
			Name:           containerName,
			Image:          c.Image,
			State:          c.State,
			ComposeProject: composeProject,
		}

		for _, m := range info.Mounts {
			// We only care about volumes and bind mounts that have a source on the host
			if m.Source == "" {
				continue
			}

			planId, isBackedUp := backedUpPaths[m.Source]
			dv := &v1.DockerVolume{
				Name:            m.Name,
				Source:          m.Source,
				Destination:     m.Destination,
				Type:            string(m.Type),
				ReadOnly:        !m.RW,
				AlreadyBackedUp: isBackedUp,
				PlanId:          planId,
			}

			// Check if the source path is reachable by backrest
			if !isRemote {
				if _, err := os.Stat(m.Source); err == nil {
					dv.PathReachable = true
				}
			} else {
				// If remote, we can't easily verify local reachability of the remote path.
				// We assume reachable if it was already configured, or just leave it false
				// to trigger the "Setup Helper" which is actually correct for remote.
				dv.PathReachable = false 
			}

			dc.Volumes = append(dc.Volumes, dv)
		}

		if len(dc.Volumes) > 0 {
			result = append(result, dc)
		}
	}

	return result, isRemote, nil
}
