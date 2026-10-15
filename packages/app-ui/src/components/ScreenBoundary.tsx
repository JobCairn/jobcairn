import { Component, type ReactNode } from "react";
import { Button } from "@careeros/brand";
import { navigate } from "../router";
import { ErrorState } from "./States";

/**
 * Catches a screen that fails to draw, so one bad file shows a plain message with a way out instead of a blank
 * window. `resetKey` (the route) clears the error when the person goes somewhere else.
 */
export class ScreenBoundary extends Component<{ resetKey: string; children: ReactNode }, { failed: boolean; key: string }> {
  state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError() { return { failed: true }; }

  static getDerivedStateFromProps(p: { resetKey: string }, s: { failed: boolean; key: string }) {
    return p.resetKey !== s.key ? { failed: false, key: p.resetKey } : null;
  }

  componentDidCatch(error: unknown) { console.error("Screen failed to draw", error); }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <ErrorState title="This page couldn't be shown"
        text="Something in its files isn't in the shape the app expects. Your files are safe. Try again, or go back to Home."
        action={<div className="row">
          <Button size="sm" variant="primary" onClick={() => this.setState({ failed: false })}>Try again</Button>
          <Button size="sm" variant="ghost" onClick={() => navigate({ screen: "home" })}>Go home</Button>
        </div>} />
    );
  }
}
