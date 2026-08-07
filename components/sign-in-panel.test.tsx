import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SignInPanel } from "@/components/sign-in-panel";

const { signIn } = vi.hoisted(() => ({ signIn: vi.fn() }));

vi.mock("next-auth/react", () => ({ signIn }));

describe("SignInPanel", () => {
  it("starts the Keycloak sign-in flow back to the workspace", () => {
    render(<SignInPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Continue with Keycloak" }));

    expect(signIn).toHaveBeenCalledWith("keycloak", { callbackUrl: "/" });
  });
});
