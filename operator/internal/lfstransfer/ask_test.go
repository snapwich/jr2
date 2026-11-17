/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package lfstransfer

import "testing"

// The ask goes to JR2_CUSTODIAN_URL when the process has it, else to the
// Custodian's fetch route at jr2's own name over plain HTTP: the User
// Container gets no env, so no trust for the Custodian's leaf (ADR-0053,
// ADR-0084).
func TestTheAskGoesToTheEnvironmentThenJr2sOwnName(t *testing.T) {
	cases := []struct {
		name string
		env  string
		want string
	}{
		{"jr2's own name", "", "http://custodian.jr2.internal/fetch"},
		{"blank is unset", "  ", "http://custodian.jr2.internal/fetch"},
		{"the environment", "https://custodian.jr2.internal/", "https://custodian.jr2.internal/fetch"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := newAsker(Options{Getenv: func(string) string { return c.env }}, "id")
			if a.endpoint != c.want {
				t.Fatalf("endpoint = %q, want %q", a.endpoint, c.want)
			}
		})
	}
}
