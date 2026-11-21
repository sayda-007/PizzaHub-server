import { Router } from 'express';

import { createAuthenticate } from '../../middlewares/authenticate.js';
import { createUserController } from './user.controller.js';
import { createUserService } from './user.service.js';

/**
 * `/api/users/me` routes.
 *
 * Authentication is applied per route, not globally, so the Better Auth
 * catch-all and public health route keep their existing behavior. Tests may
 * inject an authenticate function and a service to avoid JWKS/MongoDB.
 */
export function createUserRoutes(env, dependencies = {}) {
  const authenticate = dependencies.authenticate ?? createAuthenticate(env);

  // Production uses the default service. Tests may inject a ready-made
  // userService, but they are not required to do so.
  const service =
    dependencies.userService ??
    createUserService(dependencies.serviceDependencies ?? {});

  // The controller always receives the constructed (or injected) service.
  const controller = dependencies.userController ?? createUserController(service);

  const router = Router();

  router.get('/me', authenticate, controller.getMe);
  router.patch('/me', authenticate, controller.patchMe);

  return router;
}

export default createUserRoutes;
