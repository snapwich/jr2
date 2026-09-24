/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
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

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

// Main is the `repo-cache` subcommand of the operator binary: the cache agent
// `jr2 up` runs as a DaemonSet in every Instance namespace that has a data
// plane (ADR-0051). It watches one namespace — the Instance's — and writes one
// directory — the node's cache for that Instance. Secrets are read straight
// from the API, never cached: the agent's RBAC is `get`, and a cache would
// need `list`/`watch` over every Secret in the namespace.
func Main(args []string) int {
	fs := flag.NewFlagSet("repo-cache", flag.ContinueOnError)
	cacheDir := fs.String("cache-dir", "/cache", "The directory holding one bare clone per Repo (the hostPath mount).")
	namespace := fs.String("namespace", os.Getenv("JR2_NAMESPACE"), "The Instance namespace to watch (env JR2_NAMESPACE).")
	node := fs.String("node", os.Getenv("NODE_NAME"), "The node this agent runs on (env NODE_NAME).")
	home := fs.String("home", os.Getenv("HOME"), "Where ssh material is written (env HOME).")
	minBackoff := fs.Duration("min-backoff", 5*time.Second, "The first retry delay after a failed clone or probe.")
	maxBackoff := fs.Duration("max-backoff", 5*time.Minute, "The longest retry delay after repeated failures.")
	cloneTimeout := fs.Duration("clone-timeout", defaultCloneTimeout, "The budget for one git clone; past it the clone is killed and fails.")
	fetchTimeout := fs.Duration("fetch-timeout", defaultFetchTimeout, "The budget for one interval git fetch or probe; past it the call is killed and fails.")
	onDemandFetchTimeout := fs.Duration("on-demand-fetch-timeout", defaultOnDemandFetchTimeout, "The budget for the git fetch a Sandbox waits on before its attach; past it the Sandbox goes Ready stale.")
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
		Client:               mgr.GetClient(),
		Git:                  ExecGit(),
		CacheDir:             *cacheDir,
		Namespace:            *namespace,
		Node:                 *node,
		Home:                 *home,
		CloneTimeout:         *cloneTimeout,
		FetchTimeout:         *fetchTimeout,
		OnDemandFetchTimeout: *onDemandFetchTimeout,
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
