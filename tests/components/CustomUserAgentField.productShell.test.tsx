import { fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { expect, it, vi } from "vitest";
import { Form } from "@/components/ui/form";
import { CustomUserAgentField } from "@/components/providers/forms/CustomUserAgentField";

it("only suggests Codex User-Agents while preserving a saved custom value", async () => {
  const onChange = vi.fn();
  const saved = "legacy-client/1.0";
  function Wrapper() {
    const form = useForm();
    return (
      <Form {...form}>
        <CustomUserAgentField
          productShell
          id="test-ua"
          value={saved}
          onChange={onChange}
        />
      </Form>
    );
  }
  render(<Wrapper />);
  expect(screen.getByRole("textbox")).toHaveValue(saved);
  expect(
    screen.queryByRole("button", { name: "预设" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/claude-cli/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "custom-agent/2.0" },
  });
  expect(onChange).toHaveBeenCalledWith("custom-agent/2.0");
});
