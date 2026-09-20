/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package v1alpha1

import "time"

// AskedAnnotationPrefix is the prefix of the ask (ADR-0053): one annotation
// per Repo key, its value an RFC3339 instant, written on the Sandbox by the
// Orchestrator when something inside the pod asks for a fetch. The operator
// copies every one of them onto the pod, because the cache agent reads demand
// off pods alone; the agent then takes the later of the pod's creation and
// its ask for a key as what that node was asked for.
//
// It is a mark, not a queue: however many fetches are in flight before one
// lands, the remote is fetched once, and a fetch that started before the ask
// does not satisfy it.
const AskedAnnotationPrefix = "jr2.dev/asked-"

// AskedAnnotation is the ask annotation for one Repo cache key.
func AskedAnnotation(key string) string { return AskedAnnotationPrefix + key }

// AskedAt is an ask raised to the next whole second — the bar a fetch must
// clear to answer it.
//
// The mark carries milliseconds, so two asks in one second stay distinguishable
// to a human reading the CR, but everything that answers one is kept at the
// second: the agent stamps `lastAttempt`/`lastFetched` with the attempt's START
// (ADR-0053), and a metav1.Time survives a round trip at the second. Rounding
// the ask DOWN would count a fetch that began up to a second BEFORE the ask as
// answering it — the one thing the coalescer must never do, because that fetch
// cannot hold the commit the caller is asking about. Rounding UP cannot: a
// stamp of `ceil(ask)` belongs to a fetch that began at or after the ask. The
// cost runs the safe way and is bounded by one second — a fetch that began in
// the ask's own second could not be counted, so the node waits for the top of
// the next second before it fetches for the ask, and fetches once.
//
// An instant already ON a second is its own ceiling: nothing is asked for that
// has not happened yet.
func AskedAt(t time.Time) time.Time {
	truncated := t.Truncate(time.Second)
	if truncated.Equal(t) {
		return t
	}
	return truncated.Add(time.Second)
}
