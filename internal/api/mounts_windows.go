//go:build windows

package api

import (
	"os"
	"syscall"
)

var (
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	procGetLogicalDrives = kernel32.NewProc("GetLogicalDrives")
)

func getMounts() []string {
	var drives []string
	r1, _, _ := procGetLogicalDrives.Call()
	bitmask := uint32(r1)
	if bitmask == 0 {
		// fallback to checking common drives
		for _, drive := range []string{"C", "D", "E", "F", "G"} {
			path := drive + ":\\"
			if _, err := os.Stat(path); err == nil {
				drives = append(drives, path)
			}
		}
		return drives
	}
	for l := 'A'; l <= 'Z'; l++ {
		if bitmask&(1<<uint(l-'A')) != 0 {
			drives = append(drives, string(l)+":\\")
		}
	}
	return drives
}
