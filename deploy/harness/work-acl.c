/*
 * work-acl DIR... — stamp ADR-0005's default ACL (u::rwx,g::rwx,o::r-x) on each directory.
 *
 * The attach script runs this on every repo root it creates, before the clone that fills it: a
 * default ACL is inherited by everything created beneath, and POSIX ignores the process umask
 * where one exists, so both seats' files under a repo tree land group-writable for the work group
 * with zero umask lines in any image (ADR-0005).
 *
 * It writes the `system.posix_acl_default` xattr itself rather than linking libacl, so
 * `gcc -static` yields a truly static binary — it executes inside the USER'S image at attach
 * time, on a libc jr2 does not control, exactly why rg is vendored static (ADR-0037). The kernel
 * validates the blob on setxattr, and the Dockerfile's build reads it back with getfacl.
 *
 * A filesystem without POSIX ACL support gets a warning and exit 0, never a failure: the attach
 * runs under `sh -ec`, and a degraded default must not kill the attach — sharing falls back to
 * the umask behavior ADR-0005 keeps as defence in depth.
 */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/xattr.h>

/* include/uapi/linux/posix_acl_xattr.h: version header then (tag, perm, id) entries, fields
 * little-endian on the wire. Both vendored arches (amd64, arm64 — the same set rg pins) are
 * little-endian, so plain struct writes ARE the wire format. */
#define POSIX_ACL_XATTR_VERSION 0x0002u
#define ACL_USER_OBJ 0x01
#define ACL_GROUP_OBJ 0x04
#define ACL_OTHER 0x20
#define ACL_UNDEFINED_ID 0xFFFFFFFFu

struct acl_entry {
  uint16_t tag;
  uint16_t perm; /* r=4 w=2 x=1 */
  uint32_t id;
};

struct acl_xattr {
  uint32_t version;
  struct acl_entry entries[3]; /* must stay sorted by tag — the kernel rejects other orders */
} __attribute__((packed));

int main(int argc, char **argv) {
  /* g::rwx is the point: the work group writes. Files still land 664, not 775 — creation masks
   * the inherited entries with the requested mode (0666 for files), so x never leaks onto them. */
  static const struct acl_xattr acl = {
      POSIX_ACL_XATTR_VERSION,
      {
          {ACL_USER_OBJ, 7, ACL_UNDEFINED_ID},
          {ACL_GROUP_OBJ, 7, ACL_UNDEFINED_ID},
          {ACL_OTHER, 5, ACL_UNDEFINED_ID},
      },
  };
  if (argc < 2) {
    fprintf(stderr, "usage: work-acl DIR...\n");
    return 2;
  }
  for (int i = 1; i < argc; i++) {
    if (setxattr(argv[i], "system.posix_acl_default", &acl, sizeof acl, 0) == 0) continue;
    if (errno == ENOTSUP) {
      fprintf(stderr, "work-acl: %s: no POSIX ACL support here — sharing falls back to umask (ADR-0005)\n", argv[i]);
      continue;
    }
    perror(argv[i]);
    return 1;
  }
  return 0;
}
