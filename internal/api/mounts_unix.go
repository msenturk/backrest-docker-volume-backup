//go:build !windows

package api

import (
	"bufio"
	"os"
	"runtime"
	"strings"
)

func isUserMount(path string) bool {
	if path == "/" {
		return true
	}
	systemPrefixes := []string{
		"/proc",
		"/sys",
		"/dev",
		"/run",
		"/etc",
		"/var/lib/docker",
		"/var/lib/containers",
		"/snap",
		"/boot",
		"/tmp",
		"/lib",
	}
	for _, prefix := range systemPrefixes {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return false
		}
	}
	return true
}

func getMounts() []string {
	var mounts []string

	// Linux: parse /proc/mounts
	if runtime.GOOS == "linux" {
		file, err := os.Open("/proc/mounts")
		if err == nil {
			defer file.Close()
			scanner := bufio.NewScanner(file)
			// Deduplicate mounts
			seen := make(map[string]bool)
			for scanner.Scan() {
				fields := strings.Fields(scanner.Text())
				if len(fields) >= 2 {
					mountPoint := fields[1]
					if isUserMount(mountPoint) && !seen[mountPoint] {
						seen[mountPoint] = true
						mounts = append(mounts, mountPoint)
					}
				}
			}
		}
	}

	// macOS: read /Volumes
	if runtime.GOOS == "darwin" {
		entries, err := os.ReadDir("/Volumes")
		if err == nil {
			for _, entry := range entries {
				mounts = append(mounts, "/Volumes/"+entry.Name())
			}
		}
	}

	// Make sure "/" is always included on unix
	hasRoot := false
	for _, m := range mounts {
		if m == "/" {
			hasRoot = true
			break
		}
	}
	if !hasRoot {
		// prepend root
		mounts = append([]string{"/"}, mounts...)
	}

	return mounts
}
