package process

import "syscall"

// attributes gives each executable a group and kills it when ask dies outright.
func attributes() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}
