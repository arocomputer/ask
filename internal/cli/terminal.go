package cli

import (
	"io"
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

// availablePrompt preserves piped prompts without waiting on an open, empty pipe.
// Once input begins, read through EOF as usual; delayed input should request PROMPT=-.
func availablePrompt() (string, error) {
	fd := int(os.Stdin.Fd())
	if err := syscall.SetNonblock(fd, true); err != nil {
		return "", err
	}
	var buf [4096]byte
	var n int
	var err error
	for {
		n, err = syscall.Read(fd, buf[:])
		if err != syscall.EINTR {
			break
		}
	}
	if restore := syscall.SetNonblock(fd, false); restore != nil {
		return "", restore
	}
	if err == syscall.EAGAIN || err == syscall.EWOULDBLOCK || n == 0 && err == nil {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	rest, err := io.ReadAll(os.Stdin)
	return string(buf[:n]) + string(rest), err
}
