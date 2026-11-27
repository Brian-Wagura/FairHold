FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
RUN useradd --system --uid 10001 mediator && mkdir -p /data && chown mediator /data
USER mediator
ENV EVIDENCE_DIR=/data PORT=8787 HOST=0.0.0.0
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/index.ts"]
