#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/native/AnswerCardRecognizer/build"
OUT_DIR="${ROOT_DIR}/resources/native/linux-x64"

cmake -S "${ROOT_DIR}/native/AnswerCardRecognizer" -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="${BUILD_DIR}/install"
cmake --build "${BUILD_DIR}" --parallel
cmake --install "${BUILD_DIR}"
mkdir -p "${OUT_DIR}"
install -m 0755 "${BUILD_DIR}/install/bin/answer-card-recognizer" "${OUT_DIR}/answer-card-recognizer"
echo "Linux recognizer written to ${OUT_DIR}/answer-card-recognizer"
