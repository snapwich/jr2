/*
 * cut-lock — take an exclusive flock on the file open at stdin, and exit.
 *
 * A cut serializes on one lock per clone (cut.ts), and Node has no flock. The lock belongs to the
 * open file, not to this process: the cut opens the file (O_CLOEXEC, so no child of it inherits the
 * descriptor), gives it to this program as stdin, and keeps it open when this program exits. The lock
 * ends when the cut ends, however it ends, and a hook or a process that outlives the cut holds
 * nothing. Static, the work-acl rule (ADR-0037): it runs on a libc jr2 does not control.
 */
#include <stdio.h>
#include <sys/file.h>

int main(void) {
  if (flock(0, LOCK_EX) != 0) {
    perror("cut-lock");
    return 1;
  }
  return 0;
}
