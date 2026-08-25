FROM ubuntu:24.04

ARG RUNNER_VERSION=2.336.0
ARG LINUXDEPLOY_SHA256=421ca71d5c69ea97c6309276232990d43df1dcece0edfaa26bbf926ff96ed12e
ARG LINUXDEPLOY_PLUGIN_APPIMAGE_SHA256=a45d3e227bc7f397e9cf6bfa4c9507494efa2293357b6e86690a3de2ca992e79

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git jq libayatana-appindicator3-dev \
    librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev patchelf pkg-config squashfs-tools sudo unzip xdg-utils xz-utils \
  && useradd --create-home --shell /bin/bash runner \
  && mkdir -p /home/runner/cache/cargo-target \
  && chown -R runner:runner /home/runner/cache \
  && echo 'runner ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/runner

WORKDIR /home/runner/actions-runner

RUN curl --fail --silent --show-error --location \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
      --output /tmp/actions-runner.tar.gz \
  && echo "04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d  /tmp/actions-runner.tar.gz" | sha256sum --check \
  && tar -xzf /tmp/actions-runner.tar.gz \
  && ./bin/installdependencies.sh \
  && chown -R runner:runner /home/runner

RUN mkdir -p /home/runner/.cache/tauri \
  && curl --fail --silent --show-error --location \
    https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage \
    --output /home/runner/.cache/tauri/linuxdeploy-x86_64.AppImage.real \
  && curl --fail --silent --show-error --location \
    https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage \
    --output /home/runner/.cache/tauri/linuxdeploy-plugin-appimage-x86_64.AppImage.real \
  && echo "$LINUXDEPLOY_SHA256  /home/runner/.cache/tauri/linuxdeploy-x86_64.AppImage.real" | sha256sum --check \
  && echo "$LINUXDEPLOY_PLUGIN_APPIMAGE_SHA256  /home/runner/.cache/tauri/linuxdeploy-plugin-appimage-x86_64.AppImage.real" | sha256sum --check \
  && extract_appimage() { \
    real="$1"; \
    destination="${real%.real}.extracted"; \
    offset=""; \
    for candidate in $(grep -abo hsqs "$real" | cut -d: -f1); do \
      if unsquashfs -s -o "$candidate" "$real" >/dev/null 2>&1; then \
        offset="$candidate"; \
        break; \
      fi; \
    done; \
    test -n "$offset"; \
    unsquashfs -q -o "$offset" -d "$destination" "$real"; \
    test -x "$destination/AppRun"; \
  }; \
  extract_appimage /home/runner/.cache/tauri/linuxdeploy-x86_64.AppImage.real \
  && extract_appimage /home/runner/.cache/tauri/linuxdeploy-plugin-appimage-x86_64.AppImage.real \
  && chmod +x /home/runner/.cache/tauri/*.real \
  && chown -R runner:runner /home/runner/.cache/tauri

COPY --chown=runner:runner extracted-appimage-wrapper.sh /home/runner/.cache/tauri/linuxdeploy-x86_64.AppImage
COPY --chown=runner:runner extracted-appimage-wrapper.sh /home/runner/.cache/tauri/linuxdeploy-plugin-appimage-x86_64.AppImage
RUN chmod +x /home/runner/.cache/tauri/linuxdeploy-x86_64.AppImage \
  /home/runner/.cache/tauri/linuxdeploy-plugin-appimage-x86_64.AppImage

USER runner
ENV PATH="/home/runner/.cargo/bin:${PATH}"
ENV CARGO_BUILD_JOBS=1
ENV CARGO_TARGET_DIR=/home/runner/cache/cargo-target
RUN curl --proto '=https' --tlsv1.2 --silent --show-error https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain stable

COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh
ENTRYPOINT ["/home/runner/entrypoint.sh"]
