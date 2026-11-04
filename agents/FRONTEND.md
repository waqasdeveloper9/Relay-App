# Frontend rules

Preserve Relay's existing visual language: light workspace surfaces, purple primary actions, restrained status colors, clear typography, and reusable controls in `web/components/`. Use the existing CSS and icon conventions before adding dependencies.

Keep common connection checks and primary actions easy to find. Use responsive layouts, semantic labels, keyboard access, visible focus, and readable contrast. Dialogs need sensible focus/close behavior and usable scrolling. Tables need clear empty/loading/error states and bounded pagination.

Never silently disable an action: show the missing prerequisite or busy/cooldown reason. Prevent duplicate submissions, recover from errors, and refresh relevant state after mutations. Handle expired sessions explicitly instead of leaving a stale authenticated dashboard.

Load saved settings on refresh. Keep secrets blank with a saved-token indicator; do not refill them from an API. Preserve stored values unless the user replaces or explicitly removes them. Template selection is tenant-specific and must retain its exact name/language.

Use truthful labels: Meta accepted is not delivered, cancellation requested is not cancelled, confirmed value is not revenue, and saved credentials are not verified webhook delivery. Display review requirements and external synchronization errors alongside the affected record.

Bulk removal must explain Relay-only archival, scope/count, and restoration. Avoid implying Shopify deletion. Confirm destructive operations with the actual selected scope. Keep customer data out of unnecessary UI/debug output.

Verify changed flows in the browser when available, including narrow screens and failure states. If browser verification is unavailable, state that limitation; a successful build is not visual verification.
