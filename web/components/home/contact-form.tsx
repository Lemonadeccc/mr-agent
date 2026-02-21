"use client";

import { useCallback, useState } from "react";
import styles from "./studio-home.module.css";

interface ContactFormState {
  name: string;
  email: string;
  message: string;
}

type ContactFormErrors = Partial<Record<keyof ContactFormState, string>>;

export function ContactForm() {
  const [form, setForm] = useState<ContactFormState>({
    name: "",
    email: "",
    message: "",
  });
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<ContactFormErrors>({});

  const validate = useCallback((candidate: ContactFormState): ContactFormErrors => {
    const nextErrors: ContactFormErrors = {};
    if (!candidate.name.trim()) {
      nextErrors.name = "Required";
    }
    if (!candidate.email.trim() || !candidate.email.includes("@")) {
      nextErrors.email = "Valid email required";
    }
    if (!candidate.message.trim()) {
      nextErrors.message = "Required";
    }
    return nextErrors;
  }, []);

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validate(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className={styles.contactSuccess}>
        <p>TRANSMISSION RECEIVED</p>
        <p>We will respond within 48 grid units.</p>
      </div>
    );
  }

  return (
    <form className={styles.contactForm} onSubmit={onSubmit} noValidate>
      <label className={styles.formLabel} htmlFor="contact-name">
        Name
      </label>
      <input
        id="contact-name"
        className={styles.formInput}
        style={{ borderColor: errors.name ? "#c1121f" : "#000000" }}
        value={form.name}
        onChange={(event) =>
          setForm((previous) => ({ ...previous, name: event.target.value }))
        }
        placeholder="Your name"
      />
      {errors.name ? <span className={styles.formError}>{errors.name}</span> : null}

      <label className={styles.formLabel} htmlFor="contact-email">
        Email
      </label>
      <input
        id="contact-email"
        type="email"
        className={styles.formInput}
        style={{ borderColor: errors.email ? "#c1121f" : "#000000" }}
        value={form.email}
        onChange={(event) =>
          setForm((previous) => ({ ...previous, email: event.target.value }))
        }
        placeholder="your@email.com"
        autoComplete="email"
      />
      {errors.email ? <span className={styles.formError}>{errors.email}</span> : null}

      <label className={styles.formLabel} htmlFor="contact-message">
        Message
      </label>
      <textarea
        id="contact-message"
        className={`${styles.formInput} ${styles.formTextarea}`}
        style={{ borderColor: errors.message ? "#c1121f" : "#000000" }}
        value={form.message}
        onChange={(event) =>
          setForm((previous) => ({ ...previous, message: event.target.value }))
        }
        placeholder="Describe your project..."
      />
      {errors.message ? <span className={styles.formError}>{errors.message}</span> : null}

      <button className={styles.formSubmit} type="submit">
        Transmit
      </button>
    </form>
  );
}
