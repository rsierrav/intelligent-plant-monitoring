from supabase import create_client
import os
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# -------- SIGN UP --------
email = "testuser@gmail.com"
password = "testpassword123"

response = supabase.auth.sign_up({
    "email": email,
    "password": password
})

print("SIGN UP RESPONSE:")
print(response)

# -------- LOGIN --------
login = supabase.auth.sign_in_with_password({
    "email": email,
    "password": password
})

print("\nLOGIN RESPONSE:")
print(login)

# -------- GET USER ID --------
user = login.user

print("\nUSER ID:")
print(user.id)
