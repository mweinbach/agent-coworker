# Mobile navigation and accessibility verification

Cowork Mobile uses native tabs for Chats, Workspace, Skills, and Settings. Each tab owns an
independent Expo Router stack, and public paths such as `/thread/:id`, `/workspace/general`, and
`/settings/providers` select the owning tab automatically.

## Automated checks

Run the navigation and accessibility contracts:

```bash
bun test test/mobile.native-tabs-navigation.test.ts test/mobile.accessibility-contract.test.ts
```

Build both native bundles after route or platform-component changes:

```bash
cd apps/mobile
bunx expo export --platform ios --output-dir /tmp/cowork-mobile-ios --clear
bunx expo export --platform android --output-dir /tmp/cowork-mobile-android --clear
```

## VoiceOver and TalkBack workflow

Run this checklist on both platforms with the screen reader enabled:

1. Pair from the welcome screen by camera or pasted key. Confirm connection progress and failures
   are announced.
2. Open Chats, enter a conversation, send text, and stop an active turn. Confirm the composer and
   Stop action have names and busy/disabled state.
3. Approve and reject a pending command, then answer a pending question. Confirm focus moves to the
   request and the Chats tab exposes a badge.
4. Open a source link and expand or collapse activity, reasoning, and tool details. Confirm link and
   expanded-state semantics.
5. Switch among all four tabs, navigate into a Workspace or Settings child screen, switch tabs,
   return, and confirm each tab preserves its back stack.
6. Open Settings, Providers, Integrations, Workspace, Memory, and Backups. Confirm every interactive
   row, choice, field, switch, and destructive action has an unambiguous name and state.

## Display and motion

Repeat the core workflow at 200% text size. Controls must reflow without hiding the primary label
or action, and interactive targets must remain at least 44 points on iOS and 48 dp on Android.

Enable Reduce Motion (iOS) or Remove animations (Android), then repeat tab, workspace-switcher, and
activity interactions. Nonessential layout and modal motion must be disabled while state changes
remain understandable through labels and announcements.
