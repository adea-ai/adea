# Agent HQ Scene Core

This package is the framework-independent Three.js boundary. It owns the
imperative scene, camera, renderer, animation loop, resize, and disposal
contracts. React components and native shells may adapt to it, but the core
runtime does not import React or a platform UI framework.
