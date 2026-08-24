FROM ubuntu:24.04

ARG RUNNER_VERSION=2.336.0

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git jq libayatana-appindicator3-dev \
    librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev patchelf pkg-config sudo unzip xz-utils \
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

USER runner
ENV PATH="/home/runner/.cargo/bin:${PATH}"
ENV CARGO_BUILD_JOBS=1
ENV CARGO_TARGET_DIR=/home/runner/cache/cargo-target
RUN curl --proto '=https' --tlsv1.2 --silent --show-error https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain stable

COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh
ENTRYPOINT ["/home/runner/entrypoint.sh"]
