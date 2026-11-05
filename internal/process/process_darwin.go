package process

import "syscall"

// attributes gives each executable its own group on macOS.
func attributes() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }
