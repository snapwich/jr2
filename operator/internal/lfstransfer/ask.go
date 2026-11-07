/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package lfstransfer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/snapwich/jr2/operator/internal/uploadpack"
)

const (
	// LFSBudget is the time the cache agent has to download the objects of
	// one ask (ADR-0053). The Orchestrator waits this long and some slack.
	LFSBudget = 10 * time.Minute
	// AskTimeout is the client's backstop: the LFS budget and 30 s more, past
	// the Orchestrator's own slack, so that a hung answer cannot hang git.
	AskTimeout = LFSBudget + 30*time.Second
	// MaxAskObjects is the most objects one ask carries. A longer list goes in
	// several asks.
	MaxAskObjects = 256
	// maxBodyBytes caps what is read from the Custodian's answer.
	maxBodyBytes = 64 << 10
)

// Object is one LFS object: its sha256 oid in lowercase hex, and its size.
type Object struct {
	OID  string `json:"oid"`
	Size int64  `json:"size"`
}

// askBody is the carrier's body: the fetch ask with an `lfs` part.
type askBody struct {
	Identity string `json:"identity"`
	LFS      askLFS `json:"lfs"`
}

type askLFS struct {
	Base    string   `json:"base"`
	Objects []Object `json:"objects"`
}

// askAnswer is the Orchestrator's answer, which the Custodian relays.
type askAnswer struct {
	LFS *struct {
		Answered string `json:"answered"`
		Error    string `json:"error"`
	} `json:"lfs"`
}

// asker sends the asks of one program run.
type asker struct {
	client   *http.Client
	endpoint string
	identity string
	base     string
	// deadline, when set, ends every ask; budget is how it was given, for
	// the reason of an object that did not come in time.
	deadline time.Time
	budget   time.Duration
}

func newAsker(o Options, identity, base string) asker {
	url := uploadpack.DefaultCustodianURL
	if v := strings.TrimSpace(o.Getenv("JR2_CUSTODIAN_URL")); v != "" {
		url = v
	}
	return asker{
		client:   o.Client,
		endpoint: strings.TrimSuffix(url, "/") + "/fetch",
		identity: identity,
		base:     base,
	}
}

// ask sends one ask of 1 to MaxAskObjects objects and waits for the answer.
// It returns the empty string when the cache agent answered with no error.
// Otherwise it returns the reason: the answer's error, or a transport fault, a
// status that is not 200, or a body that is not the carrier's shape. The
// caller then reads the cache store to know what landed.
func (a asker) ask(objects []Object) string {
	body, err := json.Marshal(askBody{Identity: a.identity, LFS: askLFS{Base: a.base, Objects: objects}})
	if err != nil {
		return err.Error()
	}
	ctx, cancel := context.WithTimeout(context.Background(), AskTimeout)
	defer cancel()
	if !a.deadline.IsZero() {
		var stop context.CancelFunc
		ctx, stop = context.WithDeadline(ctx, a.deadline)
		defer stop()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, bytes.NewReader(body))
	if err != nil {
		return oneLine(err.Error())
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+uploadpack.SandboxTokenStandIn)

	resp, err := a.client.Do(req)
	if err != nil {
		if !a.deadline.IsZero() && ctx.Err() == context.DeadlineExceeded && !time.Now().Before(a.deadline) {
			return a.outOfTime()
		}
		return oneLine(err.Error())
	}
	defer func() { _ = resp.Body.Close() }()
	read, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		if !a.deadline.IsZero() && !time.Now().Before(a.deadline) {
			return a.outOfTime()
		}
		return fmt.Sprintf("the custodian's answer could not be read: %s", oneLine(err.Error()))
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("the custodian answered %s: %s", resp.Status, oneLine(string(read)))
	}
	var answer askAnswer
	if err := json.Unmarshal(read, &answer); err != nil {
		return fmt.Sprintf("the custodian's answer is not the shape jr2 speaks: %s", oneLine(err.Error()))
	}
	if answer.LFS == nil {
		return "the custodian's answer has no lfs part"
	}
	if answer.LFS.Error != "" {
		return oneLine(answer.LFS.Error)
	}
	if answer.LFS.Answered == "" {
		return "the custodian's answer names neither an answer nor an error"
	}
	return ""
}

// outOfTime is the reason of an object whose ask the budget ended.
func (a asker) outOfTime() string {
	return fmt.Sprintf("the node cache did not get it within the budget of %s", a.budget.Round(time.Second))
}

// askAll sends the objects in asks of at most MaxAskObjects, one after the
// other. It returns the reason of each object whose ask gave one.
func (a asker) askAll(objects []Object) (asks int, reasons map[string]string) {
	reasons = map[string]string{}
	for start := 0; start < len(objects); start += MaxAskObjects {
		end := min(start+MaxAskObjects, len(objects))
		chunk := objects[start:end]
		if !a.deadline.IsZero() && !time.Now().Before(a.deadline) {
			for _, obj := range chunk {
				reasons[obj.OID] = a.outOfTime()
			}
			continue
		}
		asks++
		if reason := a.ask(chunk); reason != "" {
			for _, obj := range chunk {
				reasons[obj.OID] = reason
			}
		}
	}
	return asks, reasons
}
