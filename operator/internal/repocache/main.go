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

package repocache

import (
	"flag"
	"fmt"
	"os"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
)

// Main is the `repo-cache` subcommand of the operator binary: the cache agent
// `j2 up` runs as a DaemonSet in every Instance namespace that has a data
// plane (ADR-0051). It watches one namespace — the Instance's — and writes one
// directory — the node's cache for that Instance. Secrets are read straight
// from the API, never cached: the agent's RBAC is `get`, and a cache would
// need `list`/`watch` over every Secret in the namespace.
func Main(args []string) int {
	fs := flag.NewFlagSet("repo-cache", flag.ContinueOnError)
	cacheDir := fs.String("cache-dir", "/cache", "The directory holding one bare clone per Repo (the hostPath mount).")
	namespace := fs.String("namespace", os.Getenv("J2_NAMESPACE"), "The Instance namespace to watch (env J2_NAMESPACE).")
	node := fs.String("node", os.Getenv("NODE_NAME"), "The node this agent runs on (env NODE_NAME).")
	home := fs.String("home", os.Getenv("HOME"), "Where ssh material is written (env HOME).")
	minBackoff := fs.Duration("min-backoff", 5*time.Second, "The first retry delay after a failed clone or probe.")
	maxBackoff := fs.Duration("max-backoff", 5*time.Minute, "The longest retry delay after repeated failures.")
	zapOpts := zap.Options{}
	zapOpts.BindFlags(fs)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&zapOpts)))
	log := ctrl.Log.WithName("repo-cache")

	if *namespace == "" || *node == "" {
		log.Error(fmt.Errorf("namespace %q, node %q", *namespace, *node), "Both --namespace and --node are required")
		return 2
	}

	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(corev1alpha1.AddToScheme(scheme))

	cfg, err := ctrl.GetConfig()
	if err != nil {
		log.Error(err, "No cluster configuration")
		return 1
	}
	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		Scheme:                 scheme,
		Cache:                  cache.Options{DefaultNamespaces: map[string]cache.Config{*namespace: {}}},
		Client:                 client.Options{Cache: &client.CacheOptions{DisableFor: []client.Object{&corev1.Secret{}}}},
		Metrics:                metricsserver.Options{BindAddress: "0"},
		HealthProbeBindAddress: "0",
	})
	if err != nil {
		log.Error(err, "Failed to start manager")
		return 1
	}

	agent := &Agent{
		Client:    mgr.GetClient(),
		Git:       ExecGit(),
		CacheDir:  *cacheDir,
		Namespace: *namespace,
		Node:      *node,
		Home:      *home,
	}
	if err := agent.SetupWithManager(mgr, *minBackoff, *maxBackoff); err != nil {
		log.Error(err, "Failed to create controller", "controller", "repo-cache")
		return 1
	}

	log.Info("Starting cache agent", "namespace", *namespace, "node", *node, "cacheDir", *cacheDir)
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		log.Error(err, "Failed to run manager")
		return 1
	}
	return 0
}
