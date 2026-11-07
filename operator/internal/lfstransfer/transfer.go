/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package lfstransfer

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// errorCode is the code of every error the agent sends. git-lfs shows the
// message; the code only tells it that the transfer failed.
const errorCode = 2

// eventComplete is the event that ends one transfer.
const eventComplete = "complete"

// uploadRefusal is the answer to every upload. A push from a Sandbox goes
// through the push Effect, which uploads the large files itself (ADR-0067).
const uploadRefusal = "jr2: a push from a Sandbox does not upload large files; the push Effect uploads them (ADR-0067)"

// event is one line that git-lfs sends to a custom transfer agent.
type event struct {
	Event     string `json:"event"`
	Operation string `json:"operation"`
	OID       string `json:"oid"`
	Size      int64  `json:"size"`
}

type transferError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type completeEvent struct {
	Event string         `json:"event"`
	OID   string         `json:"oid"`
	Path  string         `json:"path,omitempty"`
	Error *transferError `json:"error,omitempty"`
}

type initAnswer struct {
	Error *transferError `json:"error,omitempty"`
}

// runTransfer is jr2's standalone transfer agent: git-lfs's custom transfer
// protocol, one JSON object per line. git-lfs starts it with no `action` on an
// event, because the agent is standalone: it needs no LFS server url, and it
// gets every object from the node cache.
func runTransfer(o Options) int {
	in := bufio.NewReader(o.Stdin)
	out := json.NewEncoder(o.Stdout)
	var agent *transferAgent
	for {
		line, err := in.ReadBytes('\n')
		if len(line) > 0 {
			var ev event
			if jerr := json.Unmarshal(line, &ev); jerr != nil {
				fault(o, "the transfer agent got a line that is not JSON: %v", jerr)
				return 1
			}
			switch ev.Event {
			case "init":
				a, ierr := newTransferAgent(o)
				answer := initAnswer{}
				if ierr != nil {
					answer.Error = &transferError{Code: errorCode, Message: "jr2: " + oneLine(ierr.Error())}
				}
				if werr := out.Encode(answer); werr != nil {
					return 1
				}
				agent = a
			case "download":
				if werr := out.Encode(download(agent, ev)); werr != nil {
					return 1
				}
			case "upload":
				if werr := out.Encode(completeEvent{Event: eventComplete, OID: ev.OID,
					Error: &transferError{Code: errorCode, Message: uploadRefusal}}); werr != nil {
					return 1
				}
			case "terminate":
				return 0
			default:
				fault(o, "the transfer agent does not know the event %q", ev.Event)
				return 1
			}
		}
		if errors.Is(err, io.EOF) {
			return 0
		}
		if err != nil {
			fault(o, "the transfer agent could not read from git-lfs: %v", err)
			return 1
		}
	}
}

// transferAgent is the state that `init` makes: the checkout and the asker.
type transferAgent struct {
	checkout checkout
	asker    asker
}

func newTransferAgent(o Options) (*transferAgent, error) {
	c, err := findCheckout(o.Dir)
	if err != nil {
		return nil, err
	}
	identity := identityOf(gitConfig(o.Dir, "remote.origin.url"))
	return &transferAgent{checkout: c, asker: newAsker(o, identity, gitConfig(o.Dir, "jr2.base"))}, nil
}

// download answers one download event. A hit in the cache store is copied
// out. A miss makes one ask, and the agent then reads the cache store again.
func download(a *transferAgent, ev event) completeEvent {
	fail := func(format string, args ...any) completeEvent {
		return completeEvent{Event: eventComplete, OID: ev.OID,
			Error: &transferError{Code: errorCode, Message: "jr2: " + fmt.Sprintf(format, args...)}}
	}
	if a == nil {
		return fail("the transfer agent got a download before init")
	}
	if !oidPattern.MatchString(ev.OID) || ev.Size < 0 {
		return fail("the object %q of size %d is not an LFS object jr2 can ask for", ev.OID, ev.Size)
	}
	obj := Object{OID: ev.OID, Size: ev.Size}
	if !holds(a.checkout.cacheLFS(), obj) {
		reason := a.asker.ask([]Object{obj})
		if !holds(a.checkout.cacheLFS(), obj) {
			if reason == "" {
				reason = "the node cache does not hold it after the ask"
			}
			return fail("cannot get the large file %s (%d bytes): %s", obj.OID, obj.Size, reason)
		}
	}
	path, err := copyOut(a.checkout, obj)
	if err != nil {
		return fail("cannot copy the large file %s from the node cache: %s", obj.OID, oneLine(err.Error()))
	}
	return completeEvent{Event: eventComplete, OID: obj.OID, Path: path}
}
