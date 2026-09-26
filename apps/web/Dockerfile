# Production web image: build the SPA, serve it as static files.
#
# The API is a separate service; in production both sit behind one domain so the
# browser sees a single origin and /api routes to the API. That is why the client uses
# a relative base URL and there is no CORS configuration in the serving layer.
FROM node:20-alpine AS build

WORKDIR /repo

# Workspace manifests first, so `npm ci` caches independently of source changes.
COPY package.json package-lock.json ./
COPY packages/api-types/package.json packages/api-types/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY packages/api-types packages/api-types
COPY apps/web apps/web
RUN npm run build --workspace @understudy/web

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
