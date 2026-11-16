package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// healthcheckTimeout bounds the whole GET: connect, request and the answer's status line. The
// kubelet's exec probe has a timeout of its own (1 s by default), and a probe that outlives it is
// counted as a failure there anyway.
const healthcheckTimeout = time.Second

// healthcheck is `effector healthcheck <url>`: the exec readiness probe of a container on the Fence
// (ADR-0084, ADR-0063). No HTTP or TCP probe of the kubelet reaches a pod on the Fence, so the probe
// asks the container's own `/healthz` from inside it. It sends one GET with a 1 s timeout and exits
// 0 on 200; on any other status, a redirect or an error it says why on stderr and exits 1. It is a
// static Go binary with the standard library only, so it runs in each image that mounts /opt/jr2.
// It dials the url directly: no proxy name in the env applies, and it follows no redirect.
func healthcheck(args []string, stderr io.Writer) int {
	if len(args) != 1 {
		_, _ = fmt.Fprintln(stderr, "usage: effector healthcheck <url>")
		return 2
	}
	target, err := url.Parse(args[0])
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
		_, _ = fmt.Fprintf(stderr, "effector healthcheck: %q is not an http or https url\n", args[0])
		return 2
	}
	client := &http.Client{
		Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), healthcheckTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "effector healthcheck: %v\n", err)
		return 2
	}
	res, err := client.Do(req)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "effector healthcheck: %v\n", err)
		return 1
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		_, _ = fmt.Fprintf(stderr, "effector healthcheck: %s answered %s\n", target.Redacted(), res.Status)
		return 1
	}
	return 0
}
