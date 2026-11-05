package status

import (
	"os"
	"strconv"
	"syscall"
	"unsafe"
)

// terminalSize reads terminal dimensions from the selected stream.
func terminalSize(file *os.File) (int, int, bool) {
	var size [4]uint16
	_, _, err := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), syscall.TIOCGWINSZ, uintptr(unsafe.Pointer(&size)))
	if err != 0 {
		return fallbackWidth(), 24, false
	}
	width, height := int(size[1]), int(size[0])
	if width == 0 {
		width = fallbackWidth()
	}
	if height == 0 {
		height = 24
	}
	return width, height, true
}

// terminalWidth uses the stdout terminal width, falling back to the pipe contract.
func terminalWidth() int {
	var size [4]uint16
	_, _, e := syscall.Syscall(syscall.SYS_IOCTL, os.Stdout.Fd(), syscall.TIOCGWINSZ, uintptr(unsafe.Pointer(&size)))
	if e == 0 && size[1] > 0 {
		return int(size[1])
	}
	return 120
}

// fallbackWidth honors a positive COLUMNS value when terminal dimensions are unavailable.
func fallbackWidth() int {
	n, err := strconv.Atoi(os.Getenv("COLUMNS"))
	if err == nil && n > 0 {
		return n
	}
	return 80
}

// TerminalSize is stdout's width and height, or 80 by 24 when it isn't a terminal.
func TerminalSize() (int, int) {
	w, h, _ := terminalSize(os.Stdout)
	return w, h
}
