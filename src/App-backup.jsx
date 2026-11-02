import { useState } from "react";
import "./App.css";

export default function App() {
  const [page, setPage] = useState("home");

    return (
        <div className="app">
              <header className="header">
                      <h1>NUR2 <span>DATA</span></h1>
                              <button onClick={() => setPage("login")}>Login</button>
                                    </header>

                                          {page === "home" && (
                                                  <main className="hero">
                                                            <h2>Welcome to NUR2 DATA</h2>
                                                                      <p>Your Trusted VTU Platform</p>
                                                                                <button onClick={() => setPage("register")}>
                                                                                            Get Started
                                                                                                      </button>
                                                                                                              </main>
                                                                                                                    )}

                                                                                                                          {page === "register" && (
                                                                                                                                  <main className="card">
                                                                                                                                            <h2>Create Account</h2>
                                                                                                                                                      <input placeholder="Full Name" />
                                                                                                                                                                <input placeholder="Email Address" />
                                                                                                                                                                          <input placeholder="Phone Number" />
                                                                                                                                                                                    <input type="password" placeholder="Password" />
                                                                                                                                                                                              <button>Create Account</button>
                                                                                                                                                                                                      </main>
                                                                                                                                                                                                            )}

                                                                                                                                                                                                                  {page === "login" && (
                                                                                                                                                                                                                          <main className="card">
                                                                                                                                                                                                                                    <h2>Login</h2>
                                                                                                                                                                                                                                              <input placeholder="Email Address" />
                                                                                                                                                                                                                                                        <input type="password" placeholder="Password" />
                                                                                                                                                                                                                                                                  <button>Login</button>
                                                                                                                                                                                                                                                                          </main>
                                                                                                                                                                                                                                                                                )}

                                                                                                                                                                                                                                                                                      <footer>
                                                                                                                                                                                                                                                                                              © 2026 NUR2 DATA. All Rights Reserved.
                                                                                                                                                                                                                                                                                                    </footer>
                                                                                                                                                                                                                                                                                                        </div>
                                                                                                                                                                                                                                                                                                          );
                                                                                                                                                                                                                                                                                                          }