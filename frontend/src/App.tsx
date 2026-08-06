import React, { useState, useEffect } from "react";
import { Auth } from "./components/Auth";
import { Dashboard } from "./components/Dashboard";
import { getToken, decodeUserFromToken, UserContext } from "./utils/api";

function App() {
  const [user, setUser] = useState<UserContext | null>(null);
  const [loading, setLoading] = useState(true);

  // Check login state on mount
  useEffect(() => {
    const token = getToken();
    if (token) {
      const decodedUser = decodeUserFromToken(token);
      if (decodedUser) {
        setUser(decodedUser);
      } else {
        localStorage.removeItem("irismono_jwt_token");
      }
    }
    setLoading(false);
  }, []);

  const handleAuthSuccess = (authenticatedUser: UserContext) => {
    setUser(authenticatedUser);
  };

  const handleLogout = () => {
    setUser(null);
  };

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0b0f17" }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <>
      {user ? (
        <Dashboard user={user} onLogout={handleLogout} />
      ) : (
        <Auth onAuthSuccess={handleAuthSuccess} />
      )}
    </>
  );
}

export default App;
