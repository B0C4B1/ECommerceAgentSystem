import { useCallback } from 'react';
import { useAuth } from './auth';
import { canOperate, type PermissionAction, type PermissionResource } from './rolePermissions';

/**
 * Operation-level permission helper.
 *
 * Use it to hide or disable write actions that the current role cannot perform,
 * so the UI stays consistent with the role matrix in rolePermissions.ts.
 */
export function usePermission() {
  const { role } = useAuth();

  const can = useCallback(
    (resource: PermissionResource, action: PermissionAction) =>
      role ? canOperate(role, resource, action) : false,
    [role],
  );

  return { role, can };
}
