FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --include=dev
COPY cloud ./cloud
COPY lib/draftSync/validation.ts lib/draftSync/types.ts ./lib/draftSync/
USER pwuser
ENV NODE_ENV=production SYNC_HOST=0.0.0.0 SYNC_PORT=47832
EXPOSE 47832
CMD ["node", "cloud/start.mjs"]
