// Full runs explicitly opt backend-only child processes out of UI setup.
// Direct Bun invocations and ad hoc project runs retain the complete setup.
if (process.env.COWORK_TEST_UI_BOOTSTRAP !== "0") {
  await import("./bun-test-ui-setup");
}
