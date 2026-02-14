import type { ReactNode } from "react";

export function SettingsPageHeader(props: { title: string; subtitle?: ReactNode }) {
  return (
    <div className="settingsPageHeader">
      <div className="settingsPageTitle">{props.title}</div>
      {props.subtitle ? <div className="settingsPageSub">{props.subtitle}</div> : null}
    </div>
  );
}

export function SettingsCard(props: { title: string; right?: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <section className="settingsCard">
      <div className="settingsCardHeader">
        <div className="settingsCardTitle">{props.title}</div>
        {props.right ? <div className="settingsCardRight">{props.right}</div> : null}
      </div>
      {props.subtitle ? <div className="settingsCardSub">{props.subtitle}</div> : null}
      <div className="settingsCardBody">{props.children}</div>
    </section>
  );
}

export function SettingsRow(props: { label: ReactNode; hint?: ReactNode; control: ReactNode }) {
  return (
    <div className="settingsRow">
      <div className="settingsRowLeft">
        <div className="settingsRowLabel">{props.label}</div>
        {props.hint ? <div className="settingsRowHint">{props.hint}</div> : null}
      </div>
      <div className="settingsRowRight">{props.control}</div>
    </div>
  );
}

