// ask.sandbox: runs a command confined by Landlock and seccomp on Linux.
//
//   ask.sandbox --abi
//       Prints the kernel's Landlock ABI version (0 when Landlock is off) and exits.
//   ask.sandbox [-r PATH]... [-w PATH]... -- COMMAND [ARG]...
//       Runs COMMAND so that it, and everything it starts, can:
//       - read and run files only under the -r and -w paths, and write only under -w paths;
//       - never create internet sockets;
//       - connect only to Unix sockets it created itself (ABI 9; before that, seccomp refuses
//         Unix sockets altogether, socket pairs aside);
//       - not signal, or reach the abstract sockets of, processes outside (ABI 6);
//       - not use io_uring or VM sockets, which would get around the rules above;
//       - never gain privileges (no_new_privs: setuid programs don't elevate).
//
// Paths that don't exist are skipped. Setup failures print "ask.sandbox: ..." and exit 125, the
// command's own exit status passes through. The design is docs/contributing/sandbox.md.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

// Landlock's interface, written out so ask.sandbox builds against any kernel headers.
#define LL_CREATE_RULESET 444
#define LL_ADD_RULE 445
#define LL_RESTRICT_SELF 446
#define LL_VERSION (1U << 0)
#define LL_RULE_PATH 1

#define FS_EXECUTE (1ULL << 0)
#define FS_WRITE_FILE (1ULL << 1)
#define FS_READ_FILE (1ULL << 2)
#define FS_READ_DIR (1ULL << 3)
#define FS_REMOVE_DIR (1ULL << 4)
#define FS_REMOVE_FILE (1ULL << 5)
#define FS_MAKE_CHAR (1ULL << 6)
#define FS_MAKE_DIR (1ULL << 7)
#define FS_MAKE_REG (1ULL << 8)
#define FS_MAKE_SOCK (1ULL << 9)
#define FS_MAKE_FIFO (1ULL << 10)
#define FS_MAKE_BLOCK (1ULL << 11)
#define FS_MAKE_SYM (1ULL << 12)
#define FS_REFER (1ULL << 13)        // ABI 2
#define FS_TRUNCATE (1ULL << 14)     // ABI 3
#define FS_IOCTL_DEV (1ULL << 15)    // ABI 5
#define FS_RESOLVE_UNIX (1ULL << 16) // ABI 9
#define SCOPE_ABSTRACT_UNIX (1ULL << 0) // ABI 6
#define SCOPE_SIGNAL (1ULL << 1)        // ABI 6

struct ruleset_attr {
  uint64_t fs;
  uint64_t net;
  uint64_t scoped;
};
struct path_attr {
  uint64_t allowed;
  int32_t parent;
} __attribute__((packed));

// Rights that apply to a file, as opposed to a folder; a rule on a file may grant only these.
#define FILE_RIGHTS (FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV)

static void fail(const char *what) {
  fprintf(stderr, "ask.sandbox: %s: %s\n", what, strerror(errno));
  exit(125);
}

static void usage(void) {
  fprintf(stderr, "usage: ask.sandbox --abi\n       ask.sandbox [-r PATH]... [-w PATH]... -- COMMAND [ARG]...\n");
  exit(125);
}

static int abi(void) {
  long v = syscall(LL_CREATE_RULESET, NULL, 0, LL_VERSION);
  return v < 0 ? 0 : (int)v;
}

static void allow_path(int ruleset, const char *path, uint64_t rights) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    if (errno == ENOENT || errno == ENOTDIR || errno == EACCES) return;
    fail(path);
  }
  struct stat st;
  if (fstat(fd, &st) == 0 && !S_ISDIR(st.st_mode)) rights &= FILE_RIGHTS;
  struct path_attr rule = {.allowed = rights, .parent = fd};
  if (syscall(LL_ADD_RULE, ruleset, LL_RULE_PATH, &rule, 0) != 0) fail(path);
  close(fd);
}

#if defined(__x86_64__)
#define ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define ARCH AUDIT_ARCH_AARCH64
#else
#error "ask.sandbox supports x86_64 and aarch64"
#endif

#define DENY BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))
#define ALLOW BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
#define LOAD(field) BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, field))
// Denies when the loaded value equals k, otherwise falls through.
#define DENY_IF(k) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (k), 0, 1), DENY

/** Refuses io_uring and internet/VM sockets; Unix sockets need Landlock resolution support. */
static void seccomp(int block_unix) {
  struct sock_filter f[64];
  int n = 0;
  struct sock_filter head[] = {
      LOAD(arch),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, ARCH, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
      LOAD(nr),
#if defined(__x86_64__)
      // x32 system calls would get around the numbers below.
      BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1), DENY,
#endif
      DENY_IF(__NR_io_uring_setup),
      DENY_IF(__NR_io_uring_enter),
      DENY_IF(__NR_io_uring_register),
  };
  memcpy(f, head, sizeof head);
  n = sizeof head / sizeof head[0];
  int skip = n++; // the jump over the socket checks, filled in below
  int start = n;
  f[n++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
  struct sock_filter vsock[] = {DENY_IF(AF_VSOCK)};
  memcpy(f + n, vsock, sizeof vsock), n += 2;
  if (block_unix) {
    struct sock_filter u[] = {DENY_IF(AF_UNIX)};
    memcpy(f + n, u, sizeof u), n += 2;
  }
  {
    struct sock_filter i[] = {DENY_IF(AF_INET), DENY_IF(AF_INET6)};
    memcpy(f + n, i, sizeof i), n += 4;
  }
  f[skip] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, (unsigned char)(n - start));
  f[n++] = (struct sock_filter)ALLOW;
  struct sock_fprog prog = {.len = (unsigned short)n, .filter = f};
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) != 0) fail("seccomp");
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--abi") == 0) {
    printf("%d\n", abi());
    return 0;
  }
  char **reads = calloc(argc, sizeof *reads), **writes = calloc(argc, sizeof *writes);
  int nr = 0, nw = 0, i = 1;
  for (; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) break;
    if (i + 1 >= argc) usage();
    if (strcmp(argv[i], "-r") == 0) reads[nr++] = argv[++i];
    else if (strcmp(argv[i], "-w") == 0) writes[nw++] = argv[++i];
    else usage();
  }
  if (i + 1 >= argc) usage();
  char **command = argv + i + 1;

  int v = abi();
  if (v < 1) {
    errno = ENOSYS;
    fail("Landlock isn't available in this kernel");
  }
  uint64_t fs = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_READ_DIR | FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_CHAR | FS_MAKE_DIR |
                FS_MAKE_REG | FS_MAKE_SOCK | FS_MAKE_FIFO | FS_MAKE_BLOCK | FS_MAKE_SYM;
  if (v >= 2) fs |= FS_REFER;
  if (v >= 3) fs |= FS_TRUNCATE;
  if (v >= 5) fs |= FS_IOCTL_DEV;
  struct ruleset_attr attr = {.fs = fs, .net = 0, .scoped = v >= 6 ? SCOPE_ABSTRACT_UNIX | SCOPE_SIGNAL : 0};
  size_t size = v >= 6 ? sizeof attr : v >= 4 ? offsetof(struct ruleset_attr, scoped) : offsetof(struct ruleset_attr, net);
  int resolve = 0;
  long ruleset = -1;
  if (v >= 9) {
    attr.fs |= FS_RESOLVE_UNIX;
    ruleset = syscall(LL_CREATE_RULESET, &attr, size, 0);
    if (ruleset >= 0) resolve = 1;
    else attr.fs &= ~FS_RESOLVE_UNIX; // a kernel that numbers it differently: seccomp covers it
  }
  if (ruleset < 0) ruleset = syscall(LL_CREATE_RULESET, &attr, size, 0);
  if (ruleset < 0) fail("creating the Landlock ruleset");

  uint64_t read = (FS_EXECUTE | FS_READ_FILE | FS_READ_DIR | FS_IOCTL_DEV) & attr.fs;
  for (int k = 0; k < nr; k++) allow_path((int)ruleset, reads[k], read);
  for (int k = 0; k < nw; k++) allow_path((int)ruleset, writes[k], attr.fs);

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("no_new_privs");
  seccomp(!resolve);
  if (syscall(LL_RESTRICT_SELF, ruleset, 0) != 0) fail("entering the Landlock sandbox");
  close((int)ruleset);
  execvp(command[0], command);
  fprintf(stderr, "ask.sandbox: %s: %s\n", command[0], strerror(errno));
  return errno == ENOENT ? 127 : 126;
}
