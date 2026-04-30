/**
 * Department context middleware.
 * Resolves department_id from query param or header,
 * validates the user has access, and sets context.
 */
export async function departmentContext(c, next) {
    const departmentId =
        c.req.query('department_id') ||
        c.req.header('X-Department-Id') ||
        null;

    if (departmentId) {
        const auth = c.get('auth');
        if (!auth || !auth.memberId) {
            return c.json({ error: 'Authentication required' }, 401);
        }

        // Platform admins can access any department
        if (!auth.isPlatformAdmin && !auth.allDepartmentIds.includes(departmentId)) {
            return c.json({ error: 'No access to this department' }, 403);
        }

        c.set('departmentId', departmentId);
    }

    await next();
}

/**
 * Require department context (must have department_id set)
 */
export function requireDepartment() {
    return async (c, next) => {
        const departmentId = c.get('departmentId');
        if (!departmentId) {
            return c.json({ error: 'department_id is required' }, 400);
        }
        await next();
    };
}
