/**
 * The device, on the settings page (#178).
 *
 * One switch and what it is doing. There is nothing to pair by hand and no
 * address to type: the app scans for covey's own service and connects to what
 * answers, so the only choice a reader has here is whether to look at all.
 *
 * It is off until somebody asks, and stays off until they ask again. A scan is
 * a radio and a battery, and a person with no device must not pay for one.
 */
import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { SIZE, T } from "../theme";
import { Dot, Row, S, SectionTitle } from "../ui";
import { readDeviceWanted, saveDeviceWanted } from "../machines";
import { bridge } from "./bridge";
import { linkServiceAvailable } from "../../modules/covey-link";
import type { LinkState } from "./ble";

/** What each state of the link reads as, and the colour of its dot. */
const SAYS: Record<LinkState, { text: string; colour: string }> = {
  off: { text: "Off", colour: T.subtle },
  denied: { text: "Not allowed", colour: T.danger },
  scanning: { text: "Looking for a device…", colour: T.warning },
  connecting: { text: "Connecting…", colour: T.warning },
  ready: { text: "Connected", colour: T.success },
  lost: { text: "Out of range", colour: T.warning },
};

export function DeviceSection() {
  const [, bump] = useState(0);
  const [on, setOn] = useState(false);

  useEffect(() => {
    bridge.onChange = () => bump((n) => n + 1);
    void readDeviceWanted().then((wanted) => {
      setOn(wanted);
      if (wanted && !bridge.running()) void bridge.start();
    });
    return () => { bridge.onChange = null; };
  }, []);

  const toggle = (next: boolean) => {
    setOn(next);
    void saveDeviceWanted(next);
    if (next) void bridge.start();
    else void bridge.stop();
  };

  const info = bridge.info;
  const says = SAYS[info.state];
  const detail: string[] = [];
  if (info.firmware) detail.push(`firmware ${info.firmware}`);
  if (info.battery != null) detail.push(`${info.battery}%`);

  return (
    <>
      <SectionTitle text="Device" />
      <View style={S.card}>
        <Row first>
          <Dot colour={on ? says.colour : T.subtle} />
          <View style={S.grow}>
            <Text style={[S.title, { fontWeight: "600" }]}>Bluetooth device</Text>
            <Text style={S.subtle} numberOfLines={2}>
              {on ? says.text : "Off"}
              {info.name ? ` · ${info.name}` : ""}
              {detail.length ? ` · ${detail.join(" · ")}` : ""}
            </Text>
            {on && !linkServiceAvailable ? (
              <Text style={{ color: T.warning, fontSize: SIZE.small }}>
                This build cannot hold the link while the screen is off. Install
                the newer app to fix that.
              </Text>
            ) : null}
            {info.detail && info.state !== "ready" ? (
              <Text style={{ color: info.state === "denied" ? T.danger : T.subtle, fontSize: SIZE.small }}>
                {info.detail}
              </Text>
            ) : null}
          </View>
          <Switch
            value={on}
            onValueChange={toggle}
            trackColor={{ false: T.border, true: T.accent }}
            thumbColor={T.bg}
          />
        </Row>
        {on && info.state === "ready" ? (
          <Row>
            <View style={S.grow}>
              <Text style={S.title} numberOfLines={1}>
                {info.pointedAt ?? "No thread chosen"}
              </Text>
              <Text style={S.subtle}>
                {info.doing ?? "Hold talk on the device to speak to this thread."}
              </Text>
              {info.transcriber ? (
                <Text style={S.subtle}>
                  {info.transcriber === "phone"
                    ? "Words written by this phone."
                    : `Words written by the machine (${info.transcriber}).`}
                </Text>
              ) : null}
            </View>
          </Row>
        ) : null}
      </View>
    </>
  );
}
