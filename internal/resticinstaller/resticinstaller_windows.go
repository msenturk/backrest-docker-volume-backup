package resticinstaller

import (
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"

	"github.com/garethgeorge/backrest/internal/env"
	"go.uber.org/zap"
)

func findHelper() (string, error) {
	// Check if restic is provided via environment variable.
	resticBinOverride := env.ResticBinPath()
	if resticBinOverride != "" {
		if err := assertResticVersion(resticBinOverride, false /* strict */); err != nil {
			zap.S().Warnf("restic binary %q may not be supported by backrest: %v", resticBinOverride, err)
		}

		if _, err := os.Stat(resticBinOverride); err != nil {
			return "", fmt.Errorf("check if restic binary exists at %v: %v", resticBinOverride, err)
		}
		return resticBinOverride, nil
	}

	// Search the PATH for the specific restic version.
	if binPath, err := exec.LookPath("restic"); err == nil {
		if err := assertResticVersion(binPath, false /* strict */); err == nil {
			zap.S().Infof("restic binary %q in $PATH matches required version %v, it will be used for backrest commands", binPath, RequiredResticVersion)
			return binPath, nil
		} else {
			zap.S().Infof("restic binary %q in $PATH is not being used, it may not be supported by backrest: %v", binPath, err)
		}
	}

	// Windows specific logic: look for restic.exe in data directory.
	resticInstallPath := filepath.Join(env.DataDir(), "restic.exe")

	if err := os.MkdirAll(filepath.Dir(resticInstallPath), 0700); err != nil {
		return "", fmt.Errorf("create restic install directory %v: %w", path.Dir(resticInstallPath), err)
	}

	if err := findOrDownloadRestic(resticInstallPath); err != nil {
		// Fallback to legacy location (adjacent to binary) before failing
		legacyPath, _ := filepath.Abs(path.Join(path.Dir(os.Args[0]), "restic.exe"))
		if _, errStat := os.Stat(legacyPath); errStat == nil {
			zap.S().Infof("using bundled restic binary at %q", legacyPath)
			return legacyPath, nil
		}
		return "", fmt.Errorf("find or download restic: %w", err)
	}

	zap.S().Infof("restic binary %q in data dir matches required version %v, it will be used for backrest commands", resticInstallPath, RequiredResticVersion)
	return resticInstallPath, nil
}
