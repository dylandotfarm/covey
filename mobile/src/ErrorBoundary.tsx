/**
 * What the reader sees when the app throws (issue #168).
 *
 * A release build has no red box. Without this, an error anywhere in the tree
 * unmounts it and leaves a black screen — which is what happened the first time
 * anybody sent a message from the phone, and it said nothing at all about the
 * `uuid()` call that caused it. A blank screen is the worst failure covey has:
 * it gives the reader nothing to report and nothing to try.
 *
 * So the error is caught and shown, with the one action that is nearly always
 * right — go back to the list — beside it. The same rule the rest of covey
 * keeps: say which of the things went wrong, in the place the reader is looking.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { MONO, SIZE, T } from "./theme";
import { Button } from "./ui";

interface Props {
  children: ReactNode;
  /** Put the app back somewhere it can work, if there is such a place. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
  stack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack says *where*, which the message alone never does.
    this.setState({ stack: info.componentStack ?? null });
    console.error("covey: unhandled error", error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null, stack: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, padding: 20, gap: 14 }}>
        <Text style={{ color: T.danger, fontSize: SIZE.heading, fontWeight: "700" }}>covey stopped</Text>
        <Text style={{ color: T.text, fontSize: SIZE.body }} selectable>
          {error.message || String(error)}
        </Text>
        <ScrollView style={{ maxHeight: 280, backgroundColor: T.surface, borderRadius: 10 }}>
          <Text style={{ color: T.subtle, fontFamily: MONO, fontSize: 11, padding: 10 }} selectable>
            {/* Selectable, because the reader reporting this has to be able to copy it. */}
            {error.stack ?? ""}{stack ?? ""}
          </Text>
        </ScrollView>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Button label="Try again" tone="primary" onPress={this.reset} />
        </View>
        <Text style={{ color: T.subtle, fontSize: SIZE.small }}>
          Copy the text above into the conversation on another client, and covey can fix it.
        </Text>
      </View>
    );
  }
}
