def apply_rolling_average(df, window=30):
    return df.rolling(window=window).mean()
