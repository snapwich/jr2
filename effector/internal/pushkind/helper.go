package pushkind

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
)

// HelperUser is the user name the credential helper answers beside a token: forges read the
// token as the password of a Basic pair and take any user name, and this is the one GitHub names.
const HelperUser = "x-access-token"

// Helper is git's credential helper for a token push, and this binary is it (`effector
// git-credential get`): git asks it over a pipe, so the token crosses neither argv nor git's env.
// It reads the token from the file JR2_GIT_TOKEN_FILE names — a path in the Effector's own mount,
// never a value — and answers only `get`; `store` and `erase` are no-ops.
func Helper(args []string, stdin io.Reader, stdout io.Writer) int {
	if len(args) < 1 {
		return 2
	}
	// git writes the request's attributes, then a blank line; they are read and not used: the
	// clean repository has one remote, the Binding.
	scanner := bufio.NewScanner(stdin)
	for scanner.Scan() && scanner.Text() != "" { //nolint:revive // drain the request
	}
	if args[0] != "get" {
		return 0
	}
	file := os.Getenv("JR2_GIT_TOKEN_FILE")
	if file == "" {
		return 1
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return 1
	}
	token := strings.TrimSuffix(strings.TrimSuffix(string(raw), "\n"), "\r")
	if token == "" || strings.ContainsAny(token, "\n\x00") {
		return 1
	}
	_, _ = fmt.Fprintf(stdout, "username=%s\npassword=%s\n", HelperUser, token)
	return 0
}
