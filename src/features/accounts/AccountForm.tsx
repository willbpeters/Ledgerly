import { useState } from "react";
import { useCreateAccount } from "../../data/queries";

export function AccountForm() {
  const create = useCreateAccount();
  const [name, setName] = useState("");
  const [type, setType] = useState("brokerage");
  const [institution, setInstitution] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name: name.trim(), type, institution: institution.trim() || null },
      { onSuccess: () => { setName(""); setInstitution(""); } },
    );
  }

  return (
    <form className="row" onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Brokerage" /></label>
      <label>Type
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="brokerage">Brokerage</option>
          <option value="cash">Cash / Savings</option>
        </select>
      </label>
      <label>Institution<input value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="Fidelity" /></label>
      <button type="submit" disabled={create.isPending}>Add account</button>
    </form>
  );
}
