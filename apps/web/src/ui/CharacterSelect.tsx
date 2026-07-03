import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CHARACTER_MODEL, PISTOL_MODEL, preloadModels } from "../assets/catalog";
import { getCityGeo } from "../game/citymap";
import { CharacterSummary } from "../net/protocol";
import { api, useSession } from "../state/session";

const TINTS = [0xffffff, 0x40e8ff, 0xff2d78, 0xffe14d, 0x39ff8e, 0xb64dff];

export function CharacterSelect() {
  const token = useSession((s) => s.token);
  const enterGame = useSession((s) => s.enterGame);
  const logout = useSession((s) => s.logout);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [tintIndex, setTintIndex] = useState(0);
  const [error, setError] = useState("");

  const characters = useQuery({
    queryKey: ["characters"],
    queryFn: () => api<CharacterSummary[]>("/api/characters", { token }),
    retry: false,
  });

  // Warm the heavy world assets while the player picks a runner, so join is
  // near-instant: character + pistol GLBs and the far-field city geometry.
  useEffect(() => {
    preloadModels([CHARACTER_MODEL, PISTOL_MODEL]);
    getCityGeo().catch(() => {});
  }, []);

  const create = useMutation({
    mutationFn: (charName: string) =>
      api<CharacterSummary>("/api/characters", {
        method: "POST",
        token,
        body: { name: charName, appearance: { body: 0, tint: TINTS[tintIndex] } },
      }),
    onSuccess: () => {
      setName("");
      queryClient.invalidateQueries({ queryKey: ["characters"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  if (characters.isError) {
    // Token expired / invalid: back to login.
    logout();
    return null;
  }

  return (
    <div className="screen">
      <div className="panel">
        <h1 className="logo">WILDER</h1>
        <p className="tagline">choose your runner</p>

        {(characters.data ?? []).map((c) => (
          <div key={c.id} className="char-card" onClick={() => enterGame(c)}>
            <div>
              <div className="char-name">{c.name}</div>
              <div className="char-level">Level {c.level}</div>
            </div>
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                background: `#${c.appearance.tint.toString(16).padStart(6, "0")}`,
                boxShadow: "0 0 10px rgba(255,255,255,0.25)",
              }}
            />
          </div>
        ))}

        <div style={{ marginTop: 18 }}>
          <input
            className="field"
            placeholder="New runner name"
            value={name}
            maxLength={20}
            onChange={(e) => setName(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {TINTS.map((tint, i) => (
              <div
                key={tint}
                onClick={() => setTintIndex(i)}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  cursor: "pointer",
                  background: `#${tint.toString(16).padStart(6, "0")}`,
                  border: i === tintIndex ? "2px solid #fff" : "2px solid transparent",
                }}
              />
            ))}
          </div>
          <div className="error">{error}</div>
          <button
            className="btn btn-primary"
            disabled={name.trim().length < 2 || create.isPending}
            onClick={() => create.mutate(name.trim())}
          >
            CREATE RUNNER
          </button>
          <button className="btn btn-ghost" onClick={logout}>
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
