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
// never a value — and answers only `get`, and only for protocol https at the host
// JR2_GIT_TOKEN_HOST names (the Binding's own): a request for another origin gets nothing, so the
// token never leaves the entry that matched the Binding. `store` and `erase` are no-ops.
func Helper(args []string, stdin io.Reader, stdout io.Writer) int {
	if len(args) < 1 {
		return 2
	}
	attrs := map[string]string{}
	scanner := bufio.NewScanner(stdin)
	for scanner.Scan() && scanner.Text() != "" {
		if k, v, ok := strings.Cut(scanner.Text(), "="); ok {
			attrs[k] = v
		}
	}
	if args[0] != "get" {
		return 0
	}
	host := os.Getenv("JR2_GIT_TOKEN_HOST")
	if host == "" || attrs["protocol"] != "https" || !strings.EqualFold(attrs["host"], host) {
		return 1
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
