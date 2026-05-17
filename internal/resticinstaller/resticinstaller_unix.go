//go:build !windows

package resticinstaller

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"

	"github.com/garethgeorge/backrest/internal/env"
	"go.uber.org/zap"
)

func findHelper() (string, error) {
	// Check if restic is provided.
	resticBinOverride := env.ResticBinPath()
	if resticBinOverride != "" {
		if err := assertResticVersion(resticBinOverride, false /* strict */); err != nil {
			zap.S().Warnf("restic binary %q may not be supported by backrest: %v", resticBinOverride, err)
		}

		if _, err := os.Stat(resticBinOverride); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return "", fmt.Errorf("check if restic binary exists at %v: %v", resticBinOverride, err)
			}
			return "", fmt.Errorf("no restic binary found at %v", resticBinOverride)
		}
		return resticBinOverride, nil
	}

	// Search the PATH for the specific restic version.
	if binPath, err := exec.LookPath("restic"); err == nil {
		if err := assertResticVersion(binPath, false /* strict */); err != nil {
			zap.S().Infof("restic binary %q in $PATH matches required version %v, it will be used for backrest commands", binPath, RequiredResticVersion)
			return binPath, nil
		} else {
			zap.S().Infof("restic binary %q in $PATH is not being used, it may not be supported by backrest: %v", binPath, err)
		}
	}

	// Check for restic installation in data directory.
	resticInstallPath := filepath.Join(env.DataDir(), "restic")

	if err := os.MkdirAll(filepath.Dir(resticInstallPath), 0700); err != nil {
		return "", fmt.Errorf("create restic install directory %v: %w", path.Dir(resticInstallPath), err)
	}

	if err := findOrDownloadRestic(resticInstallPath); err != nil {
		return "", fmt.Errorf("find or download restic: %w", err)
	}

	zap.S().Infof("restic binary %q in data dir matches required version %v, it will be used for backrest commands", resticInstallPath, RequiredResticVersion)
	return resticInstallPath, nil
}
