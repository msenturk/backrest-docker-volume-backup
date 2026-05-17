package resticinstaller

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/gofrs/flock"
	"go.uber.org/zap"
)

func verify(sha256 string) error {
	sha256sums, err := getURL(hashDownloadURL(RequiredResticVersion))
	if err != nil {
		return fmt.Errorf("get sha256sums: %w", err)
	}

	signature, err := getURL(sigDownloadURL(RequiredResticVersion))
	if err != nil {
		return fmt.Errorf("get signature: %w", err)
	}

	if ok, err := gpgVerify(sha256sums, signature); !ok || err != nil {
		return fmt.Errorf("gpg verification failed: ok=%v err=%v", ok, err)
	}

	if !strings.Contains(string(sha256sums), sha256) {
		fmt.Fprintf(os.Stderr, "sha256sums:\n%v\n", string(sha256sums))
		return fmt.Errorf("sha256sums do not contain %v", sha256)
	}

	return nil
}

func installRestic(targetPath string) error {
	sha256sum, err := downloadFile(resticDownloadURL(RequiredResticVersion), targetPath+".tmp")
	if err != nil {
		return fmt.Errorf("downloading: %w", err)
	}

	if err := verify(sha256sum); err != nil {
		return fmt.Errorf("verifying: %w", err)
	}

	if err := os.Rename(targetPath+".tmp", targetPath); err != nil {
		return fmt.Errorf("renaming %v: %w", targetPath, err)
	}

	if runtime.GOOS != "windows" {
		if err := os.Chmod(targetPath, 0755); err != nil {
			return fmt.Errorf("chmod executable %v: %w", targetPath, err)
		}
	}

	return nil
}

func findOrDownloadRestic(installPath string) error {
	if err := assertResticVersion(installPath, true /* strict */); err == nil {
		return nil
	}

	lock := flock.New(filepath.Join(filepath.Dir(installPath), "install.lock"))
	if err := lock.Lock(); err != nil {
		return fmt.Errorf("acquire lock on restic install dir %v: %v", lock.Path(), err)
	}
	defer lock.Unlock()

	if err := assertResticVersion(installPath, true /* strict */); err == nil {
		return nil
	} else {
		zap.S().Infof("restic binary %v failed version validation: %v", installPath, err)
	}

	zap.S().Infof("installing restic to %v", installPath)
	if err := installRestic(installPath); err != nil {
		return fmt.Errorf("install restic: %w", err)
	}

	return nil
}
