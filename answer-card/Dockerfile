FROM node:22-bookworm AS native

ARG OPENCV_VERSION=4.13.0
RUN sed -i 's#deb.debian.org/debian#mirrors.tuna.tsinghua.edu.cn/debian#g; s#security.debian.org/debian-security#mirrors.tuna.tsinghua.edu.cn/debian-security#g' /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99force-ipv4 \
    && apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git pkg-config nlohmann-json3-dev \
    libjpeg-dev libpng-dev libtiff-dev libwebp-dev libopenjp2-7-dev \
    libavcodec-dev libavformat-dev libswscale-dev libv4l-dev \
    libxvidcore-dev libx264-dev libgtk-3-dev libeigen3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch ${OPENCV_VERSION} https://github.com/opencv/opencv.git /tmp/opencv \
    && cmake -S /tmp/opencv -B /tmp/opencv-build \
       -DCMAKE_BUILD_TYPE=Release \
       -DCMAKE_INSTALL_PREFIX=/opt/opencv \
       -DBUILD_SHARED_LIBS=OFF \
       -DBUILD_LIST=core,imgproc,imgcodecs,objdetect,calib3d,features2d \
       -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF \
       -DWITH_TBB=OFF -DWITH_IPP=OFF -DWITH_OPENCL=OFF \
    && cmake --build /tmp/opencv-build --parallel 2 \
    && cmake --install /tmp/opencv-build \
    && rm -rf /tmp/opencv /tmp/opencv-build

# OpenCV's static export may retain the optional built-in protobuf target even
# when DNN is excluded from BUILD_LIST; satisfy the exported target check.
RUN mkdir -p /opt/opencv/lib/opencv4/3rdparty \
    && test -f /opt/opencv/lib/opencv4/3rdparty/liblibprotobuf.a \
       || ar rcs /opt/opencv/lib/opencv4/3rdparty/liblibprotobuf.a

COPY native/AnswerCardRecognizer /src/native/AnswerCardRecognizer
RUN cmake -S /src/native/AnswerCardRecognizer -B /src/native/AnswerCardRecognizer/build \
      -DCMAKE_BUILD_TYPE=Release -DOpenCV_DIR=/opt/opencv/lib/cmake/opencv4 \
    && cmake --build /src/native/AnswerCardRecognizer/build --parallel \
    && mkdir -p /out \
    && cp /src/native/AnswerCardRecognizer/build/answer-card-recognizer /out/answer-card-recognizer

FROM node:22-bookworm AS build
WORKDIR /app
RUN sed -i 's#deb.debian.org/debian#mirrors.tuna.tsinghua.edu.cn/debian#g; s#security.debian.org/debian-security#mirrors.tuna.tsinghua.edu.cn/debian-security#g' /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99force-ipv4 \
    && apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm rebuild better-sqlite3 \
    && npm run typecheck && npm run build:web && npm run build:server && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=5174
ENV PROJECTX_ENABLE_SCANNER=0
ENV PROJECTX_ENABLE_SCANNER_CLIENT_API=0
WORKDIR /app
RUN sed -i 's#deb.debian.org/debian#mirrors.tuna.tsinghua.edu.cn/debian#g; s#security.debian.org/debian-security#mirrors.tuna.tsinghua.edu.cn/debian-security#g' /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99force-ipv4 \
    && apt-get update && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/resources ./resources
COPY --from=build /app/src/server/db/schema.sql /app/dist/server/schema.sql
COPY --from=build /app/src/server/db/schema.mariadb.sql /app/dist/server/schema.mariadb.sql
COPY --from=native /out/answer-card-recognizer /app/resources/native/linux-x64/answer-card-recognizer
RUN rm -rf /app/resources/native/win-ia32 /app/resources/native/win-x64 /app/resources/native/ScannerBridge \
    && chmod 0755 /app/resources/native/linux-x64/answer-card-recognizer \
    && useradd --create-home --uid 10001 app \
    && mkdir -p /app/data/answer-card \
    && chown -R app:app /app
USER app
EXPOSE 5174
CMD ["node", "dist/server/index.mjs"]
