// Linux Landlock helper inspired by OpenAI Codex's sandbox helpers.
// Reference: https://github.com/openai/codex @ 4de7a2b9d8eae19e00ca7f744647fa1aabdc204f

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <sched.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER 0
#endif

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE 0
#endif

#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV 0
#endif

static const unsigned long long READ_ACCESS =
    LANDLOCK_ACCESS_FS_EXECUTE |
    LANDLOCK_ACCESS_FS_READ_FILE |
    LANDLOCK_ACCESS_FS_READ_DIR |
    LANDLOCK_ACCESS_FS_IOCTL_DEV;

static const unsigned long long WRITE_ACCESS =
    LANDLOCK_ACCESS_FS_WRITE_FILE |
    LANDLOCK_ACCESS_FS_REMOVE_DIR |
    LANDLOCK_ACCESS_FS_REMOVE_FILE |
    LANDLOCK_ACCESS_FS_MAKE_CHAR |
    LANDLOCK_ACCESS_FS_MAKE_DIR |
    LANDLOCK_ACCESS_FS_MAKE_REG |
    LANDLOCK_ACCESS_FS_MAKE_SOCK |
    LANDLOCK_ACCESS_FS_MAKE_FIFO |
    LANDLOCK_ACCESS_FS_MAKE_BLOCK |
    LANDLOCK_ACCESS_FS_MAKE_SYM |
    LANDLOCK_ACCESS_FS_REFER |
    LANDLOCK_ACCESS_FS_TRUNCATE;

static void usage(void) {
  fprintf(stderr,
          "usage: cowork-linux-sandbox --mode <read-only|workspace-write> "
          "--cwd <path> [--network <enabled|restricted>] "
          "[--writable-root <path> ...] -- <command> [args...]\n");
}

static int add_path_rule(int ruleset_fd, const char *path, unsigned long long access) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    if (errno == ENOENT || errno == ENOTDIR) {
      return 0;
    }
    fprintf(stderr, "cowork-linux-sandbox: failed to open %s: %s\n", path, strerror(errno));
    return -1;
  }

  struct landlock_path_beneath_attr rule = {
      .allowed_access = access,
      .parent_fd = fd,
  };
  int rc = (int)syscall(__NR_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  if (rc < 0) {
    fprintf(stderr, "cowork-linux-sandbox: failed to add rule for %s: %s\n", path, strerror(errno));
  }
  close(fd);
  return rc;
}

static int apply_landlock(char **writable_roots, int writable_root_count) {
  const unsigned long long handled_access = READ_ACCESS | WRITE_ACCESS;
  struct landlock_ruleset_attr ruleset = {
      .handled_access_fs = handled_access,
  };

  int ruleset_fd = (int)syscall(__NR_landlock_create_ruleset, &ruleset, sizeof(ruleset), 0);
  if (ruleset_fd < 0) {
    fprintf(stderr, "cowork-linux-sandbox: Landlock is unavailable: %s\n", strerror(errno));
    return -1;
  }

  if (add_path_rule(ruleset_fd, "/", READ_ACCESS) < 0) {
    close(ruleset_fd);
    return -1;
  }

  // Allow common null-device writes used by shells and child-process plumbing.
  (void)add_path_rule(
      ruleset_fd,
      "/dev/null",
      LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE);

  for (int i = 0; i < writable_root_count; i++) {
    if (add_path_rule(ruleset_fd, writable_roots[i], READ_ACCESS | WRITE_ACCESS) < 0) {
      close(ruleset_fd);
      return -1;
    }
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "cowork-linux-sandbox: failed to set no_new_privs: %s\n", strerror(errno));
    close(ruleset_fd);
    return -1;
  }

  if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0) != 0) {
    fprintf(stderr, "cowork-linux-sandbox: failed to restrict process: %s\n", strerror(errno));
    close(ruleset_fd);
    return -1;
  }

  close(ruleset_fd);
  return 0;
}

int main(int argc, char **argv) {
  const char *mode = NULL;
  const char *cwd = NULL;
  const char *network = "restricted";
  char **writable_roots = calloc((size_t)argc, sizeof(char *));
  if (writable_roots == NULL) {
    fprintf(stderr, "cowork-linux-sandbox: out of memory\n");
    return 125;
  }
  int writable_root_count = 0;
  int command_index = -1;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      command_index = i + 1;
      break;
    }
    if (strcmp(argv[i], "--mode") == 0 && i + 1 < argc) {
      mode = argv[++i];
    } else if (strcmp(argv[i], "--cwd") == 0 && i + 1 < argc) {
      cwd = argv[++i];
    } else if (strcmp(argv[i], "--network") == 0 && i + 1 < argc) {
      network = argv[++i];
    } else if (strcmp(argv[i], "--writable-root") == 0 && i + 1 < argc) {
      writable_roots[writable_root_count++] = argv[++i];
    } else {
      usage();
      free(writable_roots);
      return 2;
    }
  }

  if (mode == NULL || cwd == NULL || command_index <= 0 || command_index >= argc) {
    usage();
    free(writable_roots);
    return 2;
  }

  if (strcmp(mode, "read-only") != 0 && strcmp(mode, "workspace-write") != 0) {
    fprintf(stderr, "cowork-linux-sandbox: unsupported mode: %s\n", mode);
    free(writable_roots);
    return 2;
  }

  // Network namespaces require elevated capabilities on many developer systems.
  // The TypeScript policy still marks restricted-network sessions explicitly so
  // a stricter backend can replace this helper without changing the app contract.
  if (strcmp(network, "enabled") != 0 && strcmp(network, "restricted") != 0) {
    fprintf(stderr, "cowork-linux-sandbox: unsupported network policy: %s\n", network);
    free(writable_roots);
    return 2;
  }

  if (chdir(cwd) != 0) {
    fprintf(stderr, "cowork-linux-sandbox: failed to chdir to %s: %s\n", cwd, strerror(errno));
    free(writable_roots);
    return 1;
  }

  int writable_count = strcmp(mode, "workspace-write") == 0 ? writable_root_count : 0;
  if (apply_landlock(writable_roots, writable_count) != 0) {
    free(writable_roots);
    return 125;
  }

  execvp(argv[command_index], &argv[command_index]);
  fprintf(stderr, "cowork-linux-sandbox: failed to exec %s: %s\n", argv[command_index], strerror(errno));
  free(writable_roots);
  return errno == ENOENT ? 127 : 126;
}
