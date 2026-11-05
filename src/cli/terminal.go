package cli

import (
	"os"
	"syscall"
	"unsafe"
)

// stdinTerminal distinguishes a terminal from pipes and character devices such as /dev/null.
func stdinTerminal() bool {
	var size [4]uint16
	_, _, e := syscall.Syscall(syscall.SYS_IOCTL, os.Stdin.Fd(), syscall.TIOCGWINSZ, uintptr(unsafe.Pointer(&size)))
	return e == 0
}
